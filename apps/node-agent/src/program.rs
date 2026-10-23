// SPDX-License-Identifier: Apache-2.0
//! The program of PostgreSQL, found for the page cache to keep (plan 11.2, the cold gate).
//!
//! A postmaster maps its binary and the shared libraries the binary links when it is executed, loads
//! the extension libraries `shared_preload_libraries` names, and opens a few files of the system
//! (the time zone abbreviations, the locale of its environment, OpenSSL's configuration). A strace
//! of PostgreSQL 18.6 from PGDG on Debian 13, started as the node's units start it, lists 32
//! libraries and the loader, `pg_prewarm.so` and seven such files (17 MB of the 69 MB mapped are
//! resident). The node lab of 2026-10-20 put loading that program at 21 to 35 ms when the page
//! cache holds it, and the first 24 h pass on the pool measured 144 / 407 ms (p50 / p95, EU1,
//! 2026-10-23) from the exec to 'starting PostgreSQL': what is above the lab's figure includes the
//! page faults on those files when the cache has lost them, which a node that has run no database
//! for a while, or whose databases' pages have pushed them out, has. The pool built the sandbox
//! before the wake and left this to the wake; the live pass will tell how much of it was this.
//!
//! The agent finds the files once, from the binary itself (`Program::find`: the `DT_NEEDED` entries
//! of the binary and of every library, resolved on the loader's default path; the extension
//! libraries of the settings; the system files below), and asks the kernel to read them ahead at
//! each pass of the pool's refill (`prefetch::files`, `WILLNEED` in pieces of 128 KiB, never
//! `mlock`: the kernel keeps what is used and drops what is not, and the pass reads back what it
//! dropped). A pass over files the cache holds counts their pages and reads nothing.
//!
//! **ICU's data is not read.** The binary links ICU, whose data library (`libicudata`) is 32 MB
//! of which a postmaster touches 72 KiB: a file over `MAX_FILE_BYTES` is data and not program,
//! and is left out (`Program::data_files` says how many).
use crate::{prefetch, units::slots::MAJOR};
use std::{
    collections::{HashSet, VecDeque},
    fs::File,
    os::unix::fs::FileExt,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

/// A file larger than this is data, not program: ICU's `libicudata` is 32 MB, and the whole
/// program of PostgreSQL without it is 24 MB.
const MAX_FILE_BYTES: u64 = 16 << 20;
/// Files the closure may hold: a postmaster maps 35 objects.
const MAX_FILES: usize = 256;
/// The program headers of an object that are read; a real one has fewer than 20.
const MAX_HEADERS: usize = 64;
/// The bytes of a dynamic section that are read (4,096 entries).
const MAX_DYNAMIC: u64 = 64 << 10;
/// The bytes of a library name.
const MAX_NAME: usize = 256;

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_INTERP: u32 = 3;
const DT_NULL: u64 = 0;
const DT_NEEDED: u64 = 1;
const DT_STRTAB: u64 = 5;

/// The program of a PostgreSQL: the files to keep, and what was left out or not found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Program {
    files: Vec<PathBuf>,
    /// Files the closure named that could not be found or opened: a library the loader's default
    /// path does not hold. The event of a pass adds them to its missing files.
    unresolved: u64,
    /// Files over `MAX_FILE_BYTES`, which are data.
    data_files: u64,
}

/// The directories the loader searches by default, before the cache of `ldconfig` (Debian's
/// multiarch directories first, then the plain ones that Alpine and the other layouts use).
fn library_dirs() -> Vec<PathBuf> {
    let arch = std::env::consts::ARCH;
    [
        format!("/lib/{arch}-linux-gnu"),
        format!("/usr/lib/{arch}-linux-gnu"),
        "/lib".into(),
        "/usr/lib".into(),
        "/lib64".into(),
        "/usr/lib64".into(),
    ]
    .map(PathBuf::from)
    .into()
}

/// The files besides the libraries that the postmaster opens at its start, as the node's units
/// start it: `LANG=C.UTF-8` from the image's `Locale=`, `timezone` and `lc_*` unset
/// (`settings::postgresql_conf`). Found with strace on PostgreSQL 18.6 of PGDG on Debian 13.
fn companions() -> Vec<PathBuf> {
    let arch = std::env::consts::ARCH;
    [
        format!("/usr/share/postgresql/{MAJOR}/timezonesets/Default"),
        "/usr/lib/locale/C.utf8/LC_CTYPE".into(),
        "/usr/lib/locale/C.utf8/LC_COLLATE".into(),
        "/usr/lib/locale/C.utf8/LC_MESSAGES/SYS_LC_MESSAGES".into(),
        "/usr/share/locale/locale.alias".into(),
        "/usr/lib/ssl/openssl.cnf".into(),
        format!("/usr/lib/{arch}-linux-gnu/gconv/gconv-modules.cache"),
    ]
    .map(PathBuf::from)
    .into()
}

/// What the loader needs of an ELF object, read from its headers.
#[derive(Debug, PartialEq, Eq)]
struct Object {
    /// The program interpreter (`PT_INTERP`): the loader itself.
    interpreter: Option<PathBuf>,
    /// The `DT_NEEDED` names.
    needed: Vec<String>,
}

fn word(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}
fn half(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

/// The names an ELF64 little-endian object needs: `None` for a file of another kind (a script, a
/// data file, a 32-bit object). Every read is bounded; nothing is mapped.
fn read_object(file: &File) -> Option<Object> {
    let mut header = [0u8; 64];
    file.read_exact_at(&mut header, 0).ok()?;
    // ELFCLASS64, ELFDATA2LSB, and the program header entries of 56 bytes.
    if header[..4] != *b"\x7fELF" || header[4] != 2 || header[5] != 1 || half(&header, 54) != 56 {
        return None;
    }
    let count = usize::from(half(&header, 56));
    if count == 0 || count > MAX_HEADERS {
        return None;
    }
    let mut table = vec![0u8; count * 56];
    file.read_exact_at(&mut table, word(&header, 32)).ok()?;
    // (type, offset, virtual address, size in the file)
    let segments: Vec<(u32, u64, u64, u64)> = table
        .as_chunks::<56>()
        .0
        .iter()
        .map(|entry| {
            let kind = u32::from_le_bytes([entry[0], entry[1], entry[2], entry[3]]);
            (kind, word(entry, 8), word(entry, 16), word(entry, 32))
        })
        .collect();
    let of_kind = |wanted: u32| segments.iter().find(|segment| segment.0 == wanted);
    // The file offset of a virtual address, through the loaded segment that holds it.
    let offset_of = |address: u64| {
        segments
            .iter()
            .filter(|segment| segment.0 == PT_LOAD)
            .find(|(_, _, start, size)| address >= *start && address - start < *size)
            .map(|(_, offset, start, _)| offset + (address - start))
    };
    let read_text = |at: u64, limit: usize| -> Option<String> {
        let mut text = vec![0u8; limit];
        let read = file.read_at(&mut text, at).ok()?;
        text.truncate(read);
        let end = text.iter().position(|b| *b == 0)?;
        String::from_utf8(text[..end].to_vec())
            .ok()
            .filter(|name| !name.is_empty())
    };
    // The interpreter's path is the segment's bytes up to the NUL; a segment of no bytes is none.
    let interpreter = of_kind(PT_INTERP)
        .and_then(|(_, offset, _, size)| {
            read_text(*offset, usize::try_from(*size).ok()?.min(MAX_NAME))
        })
        .map(PathBuf::from);
    let mut needed = Vec::new();
    if let Some((_, offset, _, size)) = of_kind(PT_DYNAMIC) {
        let mut dynamic = vec![0u8; usize::try_from((*size).min(MAX_DYNAMIC)).ok()?];
        file.read_exact_at(&mut dynamic, *offset).ok()?;
        let mut names = Vec::new();
        let mut strings = None;
        for entry in dynamic.as_chunks::<16>().0 {
            match word(entry, 0) {
                DT_NULL => break,
                DT_NEEDED => names.push(word(entry, 8)),
                DT_STRTAB => strings = Some(word(entry, 8)),
                _ => {}
            }
        }
        let strings = offset_of(strings?)?;
        needed = names
            .into_iter()
            .filter_map(|name| read_text(strings + name, MAX_NAME))
            .collect();
    }
    Some(Object {
        interpreter,
        needed,
    })
}

/// The file the loader would map for `name`: the name itself where it is a path, else the first
/// default directory that holds it.
fn resolve(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if name.starts_with('/') {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

/// The binary, the objects it needs and they need (names looked up in `dirs`), the interpreter
/// and the extension libraries named by `preload` in `library_dir`; each file once, by the file a
/// link leads to.
fn closure(binary: &Path, library_dir: &Path, preload: &[&str], dirs: &[PathBuf]) -> Program {
    let mut program = Program::default();
    let mut seen = HashSet::new();
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    queue.push_back(binary.to_path_buf());
    queue.extend(
        preload
            .iter()
            .map(|name| library_dir.join(format!("{name}.so"))),
    );
    while let Some(path) = queue.pop_front() {
        if program.files.len() >= MAX_FILES {
            break;
        }
        let Ok(real) = std::fs::canonicalize(&path) else {
            program.unresolved += 1;
            continue;
        };
        if !seen.insert(real.clone()) {
            continue;
        }
        let opened = File::open(&real)
            .and_then(|file| file.metadata().map(|metadata| (file, metadata)))
            .ok()
            .filter(|(_, metadata)| metadata.is_file());
        let Some((file, metadata)) = opened else {
            program.unresolved += 1;
            continue;
        };
        if metadata.len() > MAX_FILE_BYTES {
            program.data_files += 1;
            continue;
        }
        program.files.push(real);
        if let Some(object) = read_object(&file) {
            queue.extend(object.interpreter);
            for name in object.needed {
                match resolve(&name, dirs) {
                    Some(found) => queue.push_back(found),
                    None => program.unresolved += 1,
                }
            }
        }
    }
    program
}

impl Program {
    /// The program of the PostgreSQL whose `postgres` is `binary` and whose extension libraries
    /// are in `library_dir`: the binary, the objects it needs and they need, the interpreter, the
    /// libraries of `preload` (`shared_preload_libraries`), and the system files of `companions`.
    /// Blocking: it opens about 40 files and reads their headers.
    pub fn find(binary: &Path, library_dir: &Path, preload: &[&str]) -> Self {
        let mut program = closure(binary, library_dir, preload, &library_dirs());
        program.files.extend(companions());
        program
    }

    /// A program of these files, for a test that needs one whose state it knows.
    #[cfg(test)]
    pub(crate) fn from_files(files: Vec<PathBuf>) -> Self {
        Self {
            files,
            ..Self::default()
        }
    }

    /// The files to keep, the binary first. The companions come last and may not exist on a layout
    /// other than the image's: the plan counts what it does not find.
    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }

    /// Libraries the closure needs and the default path does not hold.
    pub fn unresolved(&self) -> u64 {
        self.unresolved
    }

    /// Files left out because they are data.
    pub fn data_files(&self) -> u64 {
        self.data_files
    }

    /// The plan of a pass (blocking: it opens each file once, which warms its inode).
    pub fn plan(&self, budget: Duration, cancel: &AtomicBool) -> prefetch::Plan {
        prefetch::files(&self.files, budget, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpg::{self, Cluster};
    use std::fs;

    /// A minimal ELF64 shared object: the header, four program headers (`PT_LOAD` over the whole
    /// file, `PT_INTERP`, `PT_DYNAMIC`) and a dynamic section that needs `needed`.
    fn object(needed: &[&str], interpreter: Option<&str>) -> Vec<u8> {
        let mut strings = vec![0u8];
        let mut offsets = Vec::new();
        for name in needed {
            offsets.push(strings.len() as u64);
            strings.extend(name.as_bytes());
            strings.push(0);
        }
        let interp = interpreter.map_or(Vec::new(), |path| [path.as_bytes(), &[0]].concat());
        let headers_end = 64 + 3 * 56;
        let interp_at = headers_end as u64;
        let dynamic_at = interp_at + interp.len() as u64;
        let dynamic_size = 16 * (needed.len() as u64 + 2);
        let strings_at = dynamic_at + dynamic_size;
        let total = strings_at + strings.len() as u64;
        let mut bytes = vec![0u8; total as usize];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[32..40].copy_from_slice(&64u64.to_le_bytes());
        bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&3u16.to_le_bytes());
        // The file is loaded at its own offsets: virtual address = file offset + 0x1000.
        let base = 0x1000u64;
        let mut header = |n: usize, kind: u32, offset: u64, size: u64| {
            let at = 64 + 56 * n;
            bytes[at..at + 4].copy_from_slice(&kind.to_le_bytes());
            bytes[at + 8..at + 16].copy_from_slice(&offset.to_le_bytes());
            bytes[at + 16..at + 24].copy_from_slice(&(offset + base).to_le_bytes());
            bytes[at + 32..at + 40].copy_from_slice(&size.to_le_bytes());
        };
        header(0, PT_LOAD, 0, total);
        header(1, PT_INTERP, interp_at, interp.len() as u64);
        header(2, PT_DYNAMIC, dynamic_at, dynamic_size);
        bytes[interp_at as usize..dynamic_at as usize].copy_from_slice(&interp);
        let mut entry = |n: usize, tag: u64, value: u64| {
            let at = (dynamic_at as usize) + 16 * n;
            bytes[at..at + 8].copy_from_slice(&tag.to_le_bytes());
            bytes[at + 8..at + 16].copy_from_slice(&value.to_le_bytes());
        };
        for (n, offset) in offsets.iter().enumerate() {
            entry(n, DT_NEEDED, *offset);
        }
        entry(needed.len(), DT_STRTAB, strings_at + base);
        entry(needed.len() + 1, DT_NULL, 0);
        bytes[strings_at as usize..].copy_from_slice(&strings);
        bytes
    }

    /// The loader's names are read from the headers: the interpreter and the `DT_NEEDED` entries
    /// in the order of the dynamic section, through the string table's virtual address.
    #[test]
    fn the_needed_names_and_the_interpreter_are_read_from_the_headers_of_an_object() {
        let dir = testpg::directory("program-object");
        let path = dir.join("lib.so");
        fs::write(
            &path,
            object(
                &["libc.so.6", "libm.so.6", "libz.so.1"],
                Some("/lib/ld.so.1"),
            ),
        )
        .unwrap();
        let read = read_object(&File::open(&path).unwrap()).unwrap();
        assert_eq!(read.needed, ["libc.so.6", "libm.so.6", "libz.so.1"]);
        assert_eq!(read.interpreter, Some(PathBuf::from("/lib/ld.so.1")));
        // An object with nothing to load, and without an interpreter.
        fs::write(&path, object(&[], None)).unwrap();
        let read = read_object(&File::open(&path).unwrap()).unwrap();
        assert_eq!((read.needed.len(), read.interpreter), (0, None));
        // Anything else is no object: a script, an empty file, a 32-bit object, a big-endian one,
        // headers that do not fit the file, and a string table that is nowhere.
        type Edit = fn(&mut Vec<u8>);
        let edits: [(&str, Edit); 8] = [
            ("script", |b| *b = b"#!/bin/sh\n".to_vec()),
            ("empty", |b| b.clear()),
            ("32-bit", |b| b[4] = 1),
            ("big-endian", |b| b[5] = 2),
            ("entry size", |b| b[54] = 32),
            ("too many headers", |b| b[56] = 200),
            ("truncated", |b| b.truncate(100)),
            // The string table's entry is the second of the dynamic section, which follows the
            // three program headers (no interpreter): its value is made an address in no segment.
            ("string table nowhere", |b| {
                b[64 + 3 * 56 + 16 + 8..64 + 3 * 56 + 16 + 16].copy_from_slice(&0u64.to_le_bytes());
            }),
        ];
        for (what, edit) in edits {
            let mut bytes = object(&["libc.so.6"], None);
            edit(&mut bytes);
            fs::write(&path, &bytes).unwrap();
            assert_eq!(read_object(&File::open(&path).unwrap()), None, "{what}");
        }
    }

    /// The closure follows the names to the files the loader would map, once each, through links,
    /// and leaves out what it cannot find and what is data.
    #[test]
    fn the_closure_follows_the_needed_names_once_each_and_counts_what_it_cannot_find() {
        let dir = testpg::directory("program-closure").canonicalize().unwrap();
        let lib = dir.join("lib");
        fs::create_dir_all(&lib).unwrap();
        // postgres needs a.so and b.so.1 (a link to b.so.1.2) and a library that is nowhere;
        // a.so needs b.so.1 again and a data library over the bound.
        fs::write(
            dir.join("postgres"),
            object(
                &["liba.so", "libb.so.1", "libgone.so.9"],
                Some(lib.join("ld.so").to_str().unwrap()),
            ),
        )
        .unwrap();
        fs::write(
            lib.join("liba.so"),
            object(&["libb.so.1", "libdata.so"], None),
        )
        .unwrap();
        fs::write(lib.join("libb.so.1.2"), object(&[], None)).unwrap();
        std::os::unix::fs::symlink("libb.so.1.2", lib.join("libb.so.1")).unwrap();
        fs::write(lib.join("ld.so"), object(&[], None)).unwrap();
        let data = fs::File::create(lib.join("libdata.so")).unwrap();
        data.set_len(MAX_FILE_BYTES + 1).unwrap();
        // A preload library comes from the library directory.
        fs::write(lib.join("pg_prewarm.so"), object(&["libb.so.1"], None)).unwrap();

        // The default path of the loader does not hold these names; the test gives its own.
        let dirs = vec![lib.clone()];
        let found = closure(
            &dir.join("postgres"),
            &lib,
            &["pg_prewarm", "missing"],
            &dirs,
        );
        let names: Vec<_> = found
            .files
            .iter()
            .map(|path| {
                path.strip_prefix(&dir)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            names,
            [
                "postgres",
                "lib/pg_prewarm.so",
                "lib/ld.so",
                "lib/liba.so",
                "lib/libb.so.1.2",
            ]
        );
        // libgone.so.9 is not on the path and `missing.so` is not in the directory; libdata.so is
        // data and is neither a file of the program nor a gap.
        assert_eq!((found.unresolved, found.data_files), (2, 1));
    }

    /// The program of a real PostgreSQL is every file its postmaster maps: the set the agent keeps
    /// warm is what a running postmaster has in its address space, checked against
    /// `/proc/<pid>/maps`, with the library directory the cluster was made with.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_program_holds_every_file_a_real_postmaster_maps() {
        let Some(cluster) = Cluster::create("program-maps") else {
            return;
        };
        cluster.start();
        let pid = fs::read_to_string(cluster.data().join("postmaster.pid"))
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string();
        let maps = fs::read_to_string(format!("/proc/{pid}/maps")).unwrap();
        // The objects it maps: the files that are ELF objects, below no data directory.
        let mut mapped: Vec<PathBuf> = maps
            .lines()
            .filter_map(|line| line.split_whitespace().nth(5))
            .filter(|path| path.starts_with('/') && !path.starts_with("/dev/"))
            .filter_map(|path| fs::canonicalize(path).ok())
            .filter(|path| path.is_file() && !path.starts_with(cluster.data()))
            .filter(|path| read_object(&File::open(path).unwrap()).is_some())
            .collect();
        mapped.sort();
        mapped.dedup();
        assert!(mapped.len() > 3, "{mapped:?}");
        let layout = &cluster.layout;
        let program = Program::find(
            &layout.postgres_bin.join("postgres"),
            &layout.postgres_lib,
            crate::settings::PRELOAD_LIBRARIES,
        );
        let kept: HashSet<_> = program.files().iter().cloned().collect();
        let data_files: Vec<_> = mapped
            .iter()
            .filter(|path| fs::metadata(path).unwrap().len() > MAX_FILE_BYTES)
            .collect();
        for path in &mapped {
            assert!(
                kept.contains(path) || data_files.contains(&path),
                "{} is mapped by the postmaster and is not in the program: {:?}",
                path.display(),
                program.files()
            );
        }
        assert_eq!(program.unresolved(), 0, "{:?}", program.files());
        assert_eq!(program.data_files() as usize, data_files.len());
        // The preload library and the binary are the program's own, whatever the layout.
        assert!(program.files()[0].ends_with("postgres"));
        assert!(
            program
                .files()
                .iter()
                .any(|path| path.file_name().is_some_and(|n| n == "pg_prewarm.so"))
        );
    }

    /// The pass reads nothing where the cache holds the program: on Linux, files that were read
    /// are counted resident and none is advised, and the files are advised again once the kernel
    /// has dropped them. It says where the file system cannot tell (overlayfs counts none, tmpfs
    /// keeps what it is told to drop).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_pass_over_a_resident_program_advises_nothing() {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let dir = testpg::directory("program-pass").canonicalize().unwrap();
        let lib = dir.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let big: Vec<u8> = (0..(2 << 20)).map(|n| (n % 251) as u8).collect();
        fs::write(lib.join("libbig.so"), &big).unwrap();
        fs::write(lib.join("libsmall.so"), &big[..300_000]).unwrap();
        File::open(lib.join("libbig.so"))
            .unwrap()
            .sync_all()
            .unwrap();
        File::open(lib.join("libsmall.so"))
            .unwrap()
            .sync_all()
            .unwrap();
        let program = Program {
            files: vec![lib.join("libbig.so"), lib.join("libsmall.so")],
            ..Program::default()
        };
        let pass = || {
            let cancel = AtomicBool::new(false);
            let plan = program.plan(Duration::from_secs(60), &cancel);
            plan.issue(
                prefetch::Limits {
                    budget: Duration::from_secs(60),
                    max_bytes: u64::MAX,
                },
                &cancel,
            )
        };
        for name in ["libbig.so", "libsmall.so"] {
            File::open(lib.join(name))
                .unwrap()
                .read_to_end(&mut Vec::new())
                .unwrap();
        }
        let warm = pass();
        if warm.resident_bytes.is_none_or(|bytes| bytes == 0) {
            eprintln!("skipped: this file system does not report the pages of its files");
            return;
        }
        let total = (2 << 20) + 300_000;
        assert_eq!(warm.issued_bytes, total);
        assert_eq!(
            (warm.advised, warm.stop),
            (0, prefetch::Stop::Done),
            "{warm:?}"
        );
        assert_eq!(warm.resident_bytes, Some(total));

        // The kernel drops the pages: the next pass advises every piece of them.
        for name in ["libbig.so", "libsmall.so"] {
            let file = File::open(lib.join(name)).unwrap();
            // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
            let error =
                unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
            assert_eq!(error, 0);
        }
        let cold = pass();
        if cold.resident_bytes == Some(total) {
            eprintln!("skipped: this file system keeps the pages it is told to drop");
            return;
        }
        assert_eq!(cold.advised, cold.pieces, "{cold:?}");
        assert!(cold.advised >= 2, "{cold:?}");
    }
}
