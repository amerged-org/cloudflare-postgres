// SPDX-License-Identifier: Apache-2.0
//! How much of a database's files the page cache holds, read before its unit starts (plan 5.9,
//! 9.9). A database that slept for days has had its pages evicted when memory was needed, and its
//! first statements read them from the disk; the `wake_detail` event carries this reading, so a
//! slow cold request is told from a slow node path.
//!
//! The kernel counts the cached pages of a file with `cachestat(2)` (Linux 6.5; glibc has no
//! wrapper, so it is called as a system call). The reading covers a bounded set of files of the
//! data directory, the ones a first request touches: `global/`, `pg_xact/`, the newest WAL segment
//! and the files of the user databases below `base/`, newest-modified first, at most `MAX_FILES`
//! of them and `MAX_LENGTH` bytes of file length together.
//!
//! The reading opens and lists files while the wake runs; on cold dentries that is disk reads of
//! its own, at a cost nobody has measured (plan 11.2). `prefetch` counts the pages of the files it
//! advises with its own accounting, off this reading, and shares this module's rules for opening
//! a file of the data directory: `is_directory`, `names`, `open` and `cachestat_range`.
use crate::sleep::is_segment;
use std::{
    fs::{File, OpenOptions},
    io,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// Files read at most.
const MAX_FILES: usize = 64;
/// Bytes of file length read at most, together.
const MAX_LENGTH: u64 = 256 << 20;
/// Directory entries looked at in one directory: the data directory belongs to the database's
/// user, who can fill it with files.
const MAX_ENTRIES: usize = 16_384;
/// The first object ID of the user's own objects in PostgreSQL (`FirstNormalObjectId`): the
/// databases below it are `template1`, `template0` and `postgres`.
const FIRST_USER_DATABASE: u32 = 16_384;

/// What the cache holds of one file, in pages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pages {
    pub resident: u64,
    pub dirty: u64,
    /// Evicted, and not read again since.
    pub evicted: u64,
    /// Evicted so recently that the kernel would have kept the page with more memory.
    pub recently_evicted: u64,
}

/// What the cache holds of the files read, in pages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Residency {
    /// How many files were read.
    pub files: u64,
    /// The pages their length makes.
    pub pages: u64,
    pub cached: Pages,
}

/// A file that may be read.
struct Candidate {
    path: PathBuf,
    length: u64,
    modified: SystemTime,
}

/// Whether `path` is a directory and no link to one. The data directory is the database user's,
/// who can put a link in place of any directory of it, and the agent reads as root.
pub(crate) fn is_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// The names of the entries of `directory`, sorted: none if it is no directory or is a link. At
/// most `MAX_ENTRIES` entries are looked at, and an entry is not examined (its name is all the
/// listing reads), so a directory of many files costs its blocks and no inode.
pub(crate) fn names(directory: &Path) -> Vec<String> {
    if !is_directory(directory) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .take(MAX_ENTRIES)
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    names.sort_unstable();
    names
}

/// The regular files of `directory`, which is none if it is a link. A link among them is none:
/// neither is followed. The check and the listing are two calls, so a link put there between them
/// is followed once, for the opening of files without reading them.
fn files_in(directory: &Path) -> Vec<Candidate> {
    if !is_directory(directory) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok().filter(std::fs::Metadata::is_file)?;
            Some(Candidate {
                path: entry.path(),
                length: metadata.len(),
                modified: metadata.modified().ok()?,
            })
        })
        .collect()
}

/// The files to read: nothing is chosen of a data directory that is not there or is a link.
fn select(data: &Path) -> Vec<Candidate> {
    if !is_directory(data) {
        return Vec::new();
    }
    let mut all = files_in(&data.join("global"));
    all.extend(files_in(&data.join("pg_xact")));
    all.extend(
        files_in(&data.join("pg_wal"))
            .into_iter()
            .filter(|file| {
                file.path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_segment)
            })
            .max_by_key(|file| file.modified),
    );
    let base = data.join("base");
    if is_directory(&base)
        && let Ok(databases) = std::fs::read_dir(&base)
    {
        for database in databases.take(MAX_ENTRIES).filter_map(Result::ok) {
            let user_database = database
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
                .is_some_and(|oid| oid >= FIRST_USER_DATABASE);
            if user_database {
                all.extend(files_in(&database.path()));
            }
        }
    }
    all.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    let mut length = 0u64;
    let mut chosen = Vec::new();
    for file in all {
        if chosen.len() == MAX_FILES {
            break;
        }
        // A file that does not fit is passed over: a smaller, older one may.
        if file.length > MAX_LENGTH - length {
            continue;
        }
        length += file.length;
        chosen.push(file);
    }
    chosen
}

/// The size of a page of this machine.
pub(crate) fn page_size() -> u64 {
    // SAFETY: a plain call without arguments to memory.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(size)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(4096)
}

/// Opens a file of the data directory to count its pages. The directory is the database user's:
/// a link at the file is not followed (`O_NOFOLLOW` covers the last part of the path, the
/// directories were checked when they were listed), and a pipe or a device is not opened for
/// reading.
pub(crate) fn open(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(io::ErrorKind::InvalidInput.into())
    }
}

/// The residency of the files of `data`, counted by `count` (a file and its length, to its pages).
/// `None` where no file could be counted: no data directory, or a kernel that cannot say.
pub fn read(data: &Path, count: impl Fn(&File, u64) -> io::Result<Pages>) -> Option<Residency> {
    let page = page_size();
    let mut total = Residency::default();
    for candidate in select(data) {
        let Ok(file) = open(&candidate.path) else {
            continue;
        };
        let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
            continue;
        };
        let Ok(pages) = count(&file, length) else {
            continue;
        };
        total.files += 1;
        total.pages += length.div_ceil(page);
        total.cached.resident += pages.resident;
        total.cached.dirty += pages.dirty;
        total.cached.evicted += pages.evicted;
        total.cached.recently_evicted += pages.recently_evicted;
    }
    (total.files > 0).then_some(total)
}

/// What the kernel of this machine says: `cachestat(2)`.
#[cfg(target_os = "linux")]
pub fn host(data: &Path) -> Option<Residency> {
    read(data, cachestat)
}
/// Other systems have no such call: no reading, and the event leaves its fields out.
#[cfg(not(target_os = "linux"))]
pub fn host(_data: &Path) -> Option<Residency> {
    None
}

/// `cachestat(file, {0, 0}, &status, 0)`: the pages of the whole file.
#[cfg(target_os = "linux")]
fn cachestat(file: &File, _length: u64) -> io::Result<Pages> {
    cachestat_range(file, 0, 0)
}

/// `cachestat(file, {offset, length}, &status, 0)`: the pages of a range of the file, to its end
/// where `length` is 0. The kernel looks the pages up in the page cache and reads nothing.
#[cfg(target_os = "linux")]
pub(crate) fn cachestat_range(file: &File, offset: u64, length: u64) -> io::Result<Pages> {
    use std::os::fd::AsRawFd;
    /// The same number on every architecture that has the call (Linux 6.5).
    const SYS_CACHESTAT: libc::c_long = 451;
    /// `struct cachestat_range`: from `off` for `len` bytes; both 0 is the whole file.
    #[repr(C)]
    struct Range {
        off: u64,
        len: u64,
    }
    /// `struct cachestat`.
    #[repr(C)]
    #[derive(Default)]
    struct Status {
        nr_cache: u64,
        nr_dirty: u64,
        nr_writeback: u64,
        nr_evicted: u64,
        nr_recently_evicted: u64,
    }
    let range = Range {
        off: offset,
        len: length,
    };
    let mut status = Status::default();
    let flags: libc::c_long = 0;
    // SAFETY: the kernel reads the range and writes the status, both of the layout it defines and
    // alive for the call; the descriptor is open and the flags are 0, the only value there is.
    let result = unsafe {
        libc::syscall(
            SYS_CACHESTAT,
            libc::c_long::from(file.as_raw_fd()),
            std::ptr::from_ref(&range),
            std::ptr::from_mut(&mut status),
            flags,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Pages {
        resident: status.nr_cache,
        dirty: status.nr_dirty,
        evicted: status.nr_evicted,
        recently_evicted: status.nr_recently_evicted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };

    /// A data directory with a file in each place the reading looks at, and some it must not.
    fn data(label: &str) -> PathBuf {
        let data = crate::testpg::directory(label).join("data");
        for directory in [
            "global",
            "pg_xact",
            "pg_wal/archive_status",
            "base/1",
            "base/5",
            "base/16384",
            "base/16385",
            "pg_multixact",
        ] {
            fs::create_dir_all(data.join(directory)).unwrap();
        }
        data
    }
    /// A file of `length` bytes (sparse) modified `age` seconds after the epoch.
    fn file(path: PathBuf, length: u64, age: u64) -> PathBuf {
        let handle = File::create(&path).unwrap();
        handle.set_len(length).unwrap();
        handle
            .set_modified(UNIX_EPOCH + Duration::from_secs(age))
            .unwrap();
        path
    }
    fn names(files: &[Candidate]) -> Vec<String> {
        files
            .iter()
            .map(|file| {
                let parent = file.path.parent().unwrap().file_name().unwrap();
                format!(
                    "{}/{}",
                    parent.to_str().unwrap(),
                    file.path.file_name().unwrap().to_str().unwrap()
                )
            })
            .collect()
    }

    #[test]
    fn the_reading_takes_the_files_a_first_request_touches_and_no_others() {
        let data = data("cache-select");
        file(data.join("global/pg_control"), 8192, 900);
        file(data.join("pg_xact/0000"), 262_144, 800);
        // Of the WAL segments the newest by modification time; the other files of the directory
        // are no segments.
        file(data.join("pg_wal/000000010000000000000001"), 16 << 20, 100);
        file(data.join("pg_wal/000000010000000000000002"), 16 << 20, 700);
        file(data.join("pg_wal/00000002.history"), 100, 950);
        file(
            data.join("pg_wal/archive_status/000000010000000000000002.done"),
            0,
            960,
        );
        // The user's databases only: not template1, template0 or postgres.
        file(data.join("base/1/1259"), 8192, 970);
        file(data.join("base/5/1259"), 8192, 970);
        file(data.join("base/16384/16500"), 1 << 20, 600);
        file(data.join("base/16385/16600"), 1 << 20, 500);
        // Neither of these is a file of the data directory's own.
        file(data.join("pg_multixact/0000"), 8192, 990);
        std::os::unix::fs::symlink("/etc/hosts", data.join("global/a-link")).unwrap();

        assert_eq!(
            names(&select(&data)),
            [
                "global/pg_control",
                "pg_xact/0000",
                "pg_wal/000000010000000000000002",
                "16384/16500",
                "16385/16600",
            ]
        );
        // No data directory, no files.
        assert!(select(&data.join("missing")).is_empty());
    }

    #[test]
    fn the_reading_stops_at_64_files_and_256_mib_of_length_and_prefers_the_newest() {
        let data = data("cache-bounds");
        for n in 0..100u64 {
            file(
                data.join(format!("base/16384/{}", 20_000 + n)),
                8192,
                1000 + n,
            );
        }
        let chosen = select(&data);
        assert_eq!(chosen.len(), 64);
        // The 64 newest of the 100: modified at 1036 to 1099.
        let oldest = chosen.iter().map(|file| file.modified).min().unwrap();
        assert_eq!(oldest, UNIX_EPOCH + Duration::from_secs(1036));

        // 200 MiB, then a file that does not fit, then small ones that do.
        let data = self::data("cache-length");
        file(data.join("base/16384/20001"), 200 << 20, 3000);
        file(data.join("base/16384/20002"), 100 << 20, 2000);
        file(data.join("base/16384/20003"), 50 << 20, 1000);
        file(data.join("base/16384/20004"), 6 << 20, 900);
        file(data.join("base/16384/20005"), 1 << 20, 800);
        assert_eq!(
            names(&select(&data)),
            ["16384/20001", "16384/20003", "16384/20004"]
        );
    }

    /// A pipe or a link that a file of the directory is replaced by after it was listed is not
    /// opened: a pipe would block the agent, which reads as root.
    #[test]
    fn what_is_not_a_regular_file_by_the_time_it_is_opened_is_skipped() {
        let data = data("cache-open");
        let real = file(data.join("base/16384/20001"), 4 * 4096, 100);
        let piped = data.join("base/16384/20002");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&piped)
                .status()
                .unwrap()
                .success()
        );
        let linked = data.join("base/16384/20003");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert!(open(&real).is_ok());
        assert!(open(&piped).is_err());
        assert!(open(&linked).is_err());
        // The pipe and the link are no files of the directory in the first place.
        assert_eq!(names(&select(&data)), ["16384/20001"]);
    }

    /// The database's user can put a link where the data directory has a directory, and the agent
    /// reads as root: the files behind it are not listed, so they are not opened.
    #[test]
    fn a_link_in_place_of_a_directory_is_not_followed() {
        // Each place the reading lists, replaced by a link to a directory with what it would take.
        for place in ["global", "pg_xact", "pg_wal", "base"] {
            let data = data("cache-link");
            let outside = crate::testpg::directory("cache-outside");
            file(outside.join("000000010000000000000001"), 8192, 500);
            fs::create_dir_all(outside.join("16384")).unwrap();
            file(outside.join("16384/16500"), 8192, 500);
            fs::remove_dir_all(data.join(place)).unwrap();
            std::os::unix::fs::symlink(&outside, data.join(place)).unwrap();
            assert_eq!(names(&select(&data)), Vec::<String>::new(), "{place}");
        }
        // The directory of a user database, and the data directory itself.
        let data = data("cache-link-database");
        let outside = crate::testpg::directory("cache-outside");
        file(outside.join("16500"), 8192, 500);
        fs::remove_dir_all(data.join("base/16384")).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("base/16384")).unwrap();
        assert_eq!(names(&select(&data)), Vec::<String>::new());
        let real = self::data("cache-link-data");
        file(real.join("global/pg_control"), 8192, 900);
        let linked = crate::testpg::directory("cache-linked").join("data");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert_eq!(names(&select(&real)), ["global/pg_control"]);
        assert_eq!(names(&select(&linked)), Vec::<String>::new());
    }

    #[test]
    fn a_listing_is_sorted_and_a_link_a_file_or_nothing_lists_as_empty() {
        let data = data("cache-names");
        file(data.join("base/16384/20002"), 1, 100);
        file(data.join("base/16384/20001"), 1, 100);
        file(data.join("base/16384/9"), 1, 100);
        assert_eq!(
            super::names(&data.join("base/16384")),
            ["20001", "20002", "9"]
        );
        let outside = crate::testpg::directory("cache-names-outside");
        file(outside.join("20001"), 1, 100);
        std::os::unix::fs::symlink(&outside, data.join("pg_link")).unwrap();
        assert!(super::names(&data.join("pg_link")).is_empty());
        assert!(super::names(&data.join("base/16384/20001")).is_empty());
        assert!(super::names(&data.join("missing")).is_empty());
    }

    #[test]
    fn the_residency_is_the_sum_over_the_files_and_none_where_nothing_was_counted() {
        let data = data("cache-sum");
        file(data.join("global/pg_control"), 8192, 900);
        file(data.join("base/16384/20001"), 10_000, 800);
        let pages = |resident, dirty, evicted, recently_evicted| Pages {
            resident,
            dirty,
            evicted,
            recently_evicted,
        };
        // Every file holds 2 resident pages, 1 dirty, 3 evicted of which 1 recently.
        let residency = read(&data, |_, _| Ok(pages(2, 1, 3, 1))).unwrap();
        let page = page_size();
        assert_eq!(
            residency,
            Residency {
                files: 2,
                pages: 8192u64.div_ceil(page) + 10_000u64.div_ceil(page),
                cached: pages(4, 2, 6, 2),
            }
        );
        // A file that cannot be counted is left out of the sum.
        let first = std::cell::Cell::new(true);
        let one = read(&data, |_, _| {
            if first.replace(false) {
                Err(io::ErrorKind::Unsupported.into())
            } else {
                Ok(pages(1, 0, 0, 0))
            }
        })
        .unwrap();
        assert_eq!((one.files, one.cached), (1, pages(1, 0, 0, 0)));
        // A kernel that cannot say, and a directory that is not there.
        assert_eq!(
            read(&data, |_, _| Err(io::ErrorKind::Unsupported.into())),
            None
        );
        assert_eq!(
            read(&data.join("missing"), |_, _| Ok(Pages::default())),
            None
        );
    }

    /// The kernel's own count of a real file: resident after it was read, gone after the kernel
    /// was told to drop it. What the call reports depends on the file system: overlayfs (the
    /// root of a container) counts the pages of its own inode and finds none, and a tmpfs keeps
    /// every page whatever it is told. The test runs on Linux and says where it cannot check.
    #[cfg(target_os = "linux")]
    #[test]
    fn cachestat_counts_the_pages_of_a_file_that_is_read_and_one_that_is_dropped() {
        use std::{
            io::{Read, Seek},
            os::fd::AsRawFd,
        };
        let path = crate::testpg::directory("cache-real").join("file");
        let bytes: Vec<u8> = (0..256 * 4096).map(|i| (i % 251) as u8).collect();
        fs::write(&path, &bytes).unwrap();
        File::open(&path).unwrap().sync_all().unwrap();
        let mut file = File::open(&path).unwrap();
        let count = |file: &File| match cachestat(file, 0) {
            Ok(pages) => Some(pages),
            Err(error) if error.raw_os_error() == Some(libc::ENOSYS) => None,
            Err(error) => panic!("cachestat: {error}"),
        };
        let page = page_size();
        let total = 256 * 4096 / page;

        file.read_to_end(&mut Vec::new()).unwrap();
        let Some(cached) = count(&file) else {
            eprintln!("skipped: this kernel has no cachestat");
            return;
        };
        if cached.resident == 0 {
            eprintln!("skipped: this file system does not report the pages of its files");
            return;
        }
        assert_eq!(cached.resident, total, "{cached:?}");
        assert_eq!(cached.dirty, 0, "{cached:?}");

        // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
        let error =
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        assert_eq!(error, 0);
        let dropped = count(&file).unwrap();
        if dropped.resident == cached.resident {
            eprintln!("skipped: this file system keeps the pages it is told to drop");
            return;
        }
        assert_eq!(dropped.resident, 0, "{dropped:?}");

        // A range counts its own pages: only the second half is read, and the first half, the
        // second half and "to the end of the file from the middle" say so.
        let half = 128 * 4096;
        file.seek(std::io::SeekFrom::Start(half)).unwrap();
        file.read_exact(&mut vec![0u8; half as usize]).unwrap();
        let resident = |offset, length| cachestat_range(&file, offset, length).unwrap().resident;
        assert_eq!(resident(0, half), 0);
        assert_eq!(resident(half, half), half / page);
        assert_eq!(resident(half, 0), half / page);
        assert_eq!(resident(0, 0), half / page);

        // Read again: every page is back. The whole reading finds the file below a data
        // directory and counts it the same way.
        file.rewind().unwrap();
        file.read_to_end(&mut Vec::new()).unwrap();
        assert_eq!(count(&file).unwrap().resident, total);
        let data = path.parent().unwrap().join("data");
        fs::create_dir_all(data.join("global")).unwrap();
        fs::copy(&path, data.join("global/pg_control")).unwrap();
        let residency = host(&data).unwrap();
        assert_eq!((residency.files, residency.pages), (1, total));
        assert_eq!(residency.cached.resident, total);
    }
}
