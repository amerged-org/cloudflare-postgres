// SPDX-License-Identifier: Apache-2.0
//! The node's private files: the key, the identity and the outbox. Each is written whole, or not
//! at all, and readable by the agent's user only.
use std::{
    fs::{DirBuilder, File, OpenOptions, Permissions},
    io::{Result, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

/// Creates `directory` and its parents, readable by its owner only. A `directory` that exists
/// keeps the mode it was created with, so it is made private as well, whatever mode the installer
/// gave it: other users must not list the node's files.
pub(crate) fn create_private_directory(directory: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    std::fs::set_permissions(directory, Permissions::from_mode(0o700))
}

/// Makes the rename and removal of an entry of `directory` durable.
pub(crate) fn sync_directory(directory: &Path) -> Result<()> {
    File::open(directory)?.sync_all()
}

/// Replaces `path` with `bytes` in one step that survives a crash: a 0600 file beside it is
/// written and fsynced, renamed over `path`, and the directory is fsynced. A reader sees the old
/// content or the new, never a part.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    let name = path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;
    let mut partial = name.to_os_string();
    partial.push(".partial");
    let partial = directory.join(partial);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)?;
    // A partial file a crash left behind keeps the mode it was created with.
    file.set_permissions(Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&partial, path)?;
    sync_directory(directory)
}

#[cfg(test)]
mod tests {
    use super::{super::test_server::tempdir, *};

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_private_file_replaces_the_old_one_whole_and_is_readable_by_its_owner_only() {
        let base = tempdir();
        let directory = base.join("credentials");
        create_private_directory(&directory).unwrap();
        assert_eq!(mode(&directory), 0o700);
        let path = directory.join("node.json");
        write_private(&path, b"first").unwrap();
        write_private(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(mode(&path), 0o600);
        // A partial file a crash left behind, with a wider mode, is replaced and renamed away.
        let partial = directory.join("node.json.partial");
        std::fs::write(&partial, b"torn").unwrap();
        std::fs::set_permissions(&partial, Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"third").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"third");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn a_directory_that_exists_with_a_wider_mode_becomes_private_with_its_files_untouched() {
        let base = tempdir();
        let directory = base.join("credentials");
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, Permissions::from_mode(0o755)).unwrap();
        let path = directory.join("node.json");
        write_private(&path, b"identity").unwrap();
        create_private_directory(&directory).unwrap();
        assert_eq!(mode(&directory), 0o700);
        assert_eq!(std::fs::read(&path).unwrap(), b"identity");
        // Parents that did not exist are private as well.
        let nested = base.join("a/b");
        create_private_directory(&nested).unwrap();
        assert_eq!(
            (mode(&nested), mode(nested.parent().unwrap())),
            (0o700, 0o700)
        );
    }
}
