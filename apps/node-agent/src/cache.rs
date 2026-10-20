// SPDX-License-Identifier: Apache-2.0
//! How the agent opens and counts the files of a database's data directory (plan 5.9, 9.9). The
//! data directory belongs to the database's user, who can put a link in place of any directory of
//! it, and the agent reads as root: `prefetch` plans and advises the files a first request reads
//! with the rules of this module, and counts the pages of the cache that held them with
//! `cachestat(2)`.
//!
//! The kernel counts the cached pages of a file with `cachestat(2)` (Linux 6.5; glibc has no
//! wrapper, so it is called as a system call). It looks the pages up and reads nothing.
use std::{
    fs::{DirEntry, File, OpenOptions},
    io,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

/// Directory entries looked at in one directory: the data directory belongs to the database's
/// user, who can fill it with files.
const MAX_ENTRIES: usize = 16_384;

/// Whether `path` is a directory and no link to one. The data directory is the database user's,
/// who can put a link in place of any directory of it, and the agent reads as root.
pub(crate) fn is_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// The names of the entries of `directory` that `wanted` accepts, sorted: none if it is no
/// directory or is a link. At most `MAX_ENTRIES` entries are looked at.
fn listing(directory: &Path, wanted: impl Fn(&DirEntry) -> bool) -> Vec<String> {
    if !is_directory(directory) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let entry = entry.ok()?;
            wanted(&entry)
                .then(|| entry.file_name().into_string().ok())
                .flatten()
        })
        .collect();
    names.sort_unstable();
    names
}

/// The names of the entries of `directory`, sorted: none if it is no directory or is a link. An
/// entry is not examined (its name is all the listing reads), so a directory of many files costs
/// its blocks and no inode.
pub(crate) fn names(directory: &Path) -> Vec<String> {
    listing(directory, |_| true)
}

/// The names of the subdirectories of `directory`, sorted: none if it is no directory or is a
/// link. A link, a file or a pipe among the entries is no subdirectory. The type comes with the
/// listing on the file systems that have one (and from one `lstat` where they have not).
pub(crate) fn subdirectories(directory: &Path) -> Vec<String> {
    listing(directory, |entry| {
        entry.file_type().is_ok_and(|kind| kind.is_dir())
    })
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

/// Opens a file of the data directory to read its length and advise the kernel on it. The
/// directory is the database user's: a link at the file is not followed (`O_NOFOLLOW` covers the
/// last part of the path; the directories are checked by the caller), and a pipe or a device is
/// not opened for reading.
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

/// `cachestat(file, {offset, length}, &status, 0)`: the pages of a range of the file that the page
/// cache holds, to its end of the file where `length` is 0. The kernel looks the pages up and
/// reads nothing.
#[cfg(target_os = "linux")]
pub(crate) fn cachestat_range(file: &File, offset: u64, length: u64) -> io::Result<u64> {
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
    Ok(status.nr_cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{Duration, UNIX_EPOCH},
    };

    /// A data directory with the places a plan lists.
    fn data(label: &str) -> PathBuf {
        let data = crate::testpg::directory(label).join("data");
        for directory in ["global", "base/1", "base/16384", "pg_multixact"] {
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
        // A directory is no file to open.
        assert!(open(&data.join("base/16384")).is_err());
    }

    #[test]
    fn a_listing_is_sorted_and_a_link_a_file_or_nothing_lists_as_empty() {
        let data = data("cache-names");
        file(data.join("base/16384/20002"), 1, 100);
        file(data.join("base/16384/20001"), 1, 100);
        file(data.join("base/16384/9"), 1, 100);
        assert_eq!(names(&data.join("base/16384")), ["20001", "20002", "9"]);
        let outside = crate::testpg::directory("cache-names-outside");
        file(outside.join("20001"), 1, 100);
        std::os::unix::fs::symlink(&outside, data.join("pg_link")).unwrap();
        assert!(names(&data.join("pg_link")).is_empty());
        assert!(names(&data.join("base/16384/20001")).is_empty());
        assert!(names(&data.join("missing")).is_empty());
    }

    /// `base/` of the database's user holds what the user puts there: only a real directory is a
    /// database, not a link to one, a file or a pipe.
    #[test]
    fn a_subdirectory_is_a_real_directory_and_not_a_link_a_file_or_a_pipe() {
        let data = data("cache-subdirectories");
        let base = data.join("base");
        fs::create_dir_all(base.join("16385")).unwrap();
        file(base.join("16386"), 1, 100);
        std::os::unix::fs::symlink(base.join("16385"), base.join("16387")).unwrap();
        std::os::unix::fs::symlink(base.join("missing"), base.join("16388")).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(base.join("16389"))
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(subdirectories(&base), ["1", "16384", "16385"]);
        // Nothing of a link to a directory, of a file or of what is not there.
        let outside = crate::testpg::directory("cache-subdirectories-outside");
        fs::create_dir_all(outside.join("16390")).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("pg_link")).unwrap();
        assert!(subdirectories(&data.join("pg_link")).is_empty());
        assert!(subdirectories(&base.join("16386")).is_empty());
        assert!(subdirectories(&base.join("missing")).is_empty());
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
        let count = |file: &File| match cachestat_range(file, 0, 0) {
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
        if cached == 0 {
            eprintln!("skipped: this file system does not report the pages of its files");
            return;
        }
        assert_eq!(cached, total);

        // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
        let error =
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        assert_eq!(error, 0);
        let dropped = count(&file).unwrap();
        if dropped == cached {
            eprintln!("skipped: this file system keeps the pages it is told to drop");
            return;
        }
        assert_eq!(dropped, 0);

        // A range counts its own pages: only the second half is read, and the first half, the
        // second half and "to the end of the file from the middle" say so.
        let half = 128 * 4096;
        file.seek(std::io::SeekFrom::Start(half)).unwrap();
        file.read_exact(&mut vec![0u8; half as usize]).unwrap();
        let resident = |offset, length| cachestat_range(&file, offset, length).unwrap();
        assert_eq!(resident(0, half), 0);
        assert_eq!(resident(half, half), half / page);
        assert_eq!(resident(half, 0), half / page);
        assert_eq!(resident(0, 0), half / page);

        // Read again: every page is back.
        file.rewind().unwrap();
        file.read_to_end(&mut Vec::new()).unwrap();
        assert_eq!(count(&file).unwrap(), total);
    }
}
