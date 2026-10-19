// SPDX-License-Identifier: Apache-2.0
//! The operator shell's CA key on the node (ULTRA plan 8). sshd takes a user certificate for root
//! signed by the CA in one file, and nothing else; without the file it refuses every key, and it
//! opens the file again for every certificate it checks, so neither a reload nor a restart is
//! needed when the file appears or goes. The agent keeps the file as Cloudflare's credentials say:
//! the key is there while the field is, and the file is gone when the field is. The key is public,
//! and the log and the events say that the file was written or removed, never what it held.
use crate::link::file::{sync_directory, write_file};
use serde_json::Value;
use std::{io, os::unix::fs::PermissionsExt, path::Path};

/// What `apply` did to the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    Written,
    Removed,
    Unchanged,
}

impl Change {
    /// The event that tells Cloudflare's logs the shell's state on the node, if it changed.
    pub(crate) fn event(self) -> Option<&'static str> {
        match self {
            Self::Written => Some("shell_ca_written"),
            Self::Removed => Some("shell_ca_removed"),
            Self::Unchanged => None,
        }
    }
}

/// The key `NodeCredentials` carries, or `None` when the field is absent.
pub(crate) fn key_of(credentials: &Value) -> Option<&str> {
    credentials["shell_ca_public_key"].as_str()
}

/// Makes `path` hold `key` and one line break, 0644 and owned by whoever runs the agent (root), or
/// not exist when there is no key. The contract's schema has checked the key; one more look here,
/// because a second line in this file would be a second CA.
pub(crate) fn apply(path: &Path, key: Option<&str>) -> io::Result<Change> {
    let Some(key) = key else {
        return match std::fs::remove_file(path) {
            Ok(()) => {
                sync_directory(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
                Ok(Change::Removed)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Change::Unchanged),
            Err(error) => Err(error),
        };
    };
    if key.is_empty() || !key.bytes().all(|byte| (0x20..0x7f).contains(&byte)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the shell CA key is not one line of printable text",
        ));
    }
    let wanted = format!("{key}\n");
    let current = std::fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o7777 == 0o644);
    if current.is_some() && std::fs::read(path)? == wanted.as_bytes() {
        return Ok(Change::Unchanged);
    }
    write_file(path, wanted.as_bytes(), 0o644)?;
    Ok(Change::Written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::test_server::tempdir;
    use serde_json::json;
    use std::os::unix::fs::{MetadataExt, symlink};

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDNcY+bgo/xfpIZts7k+ekO/ruRsypcSnZW0qomRI8bp";
    const OTHER: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDNdY+bgo/xfpIZts7k+ekO/ruRsypcSnZW0qomRI8bp";

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }
    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_key_is_written_whole_and_world_readable_and_replaced_when_it_differs() {
        let directory = tempdir();
        let path = directory.join("pgcf_user_ca.pub");
        assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Written);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{KEY}\n"));
        assert_eq!(mode(&path), 0o644);
        // The same key again changes nothing.
        let inode = std::fs::metadata(&path).unwrap().ino();
        assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Unchanged);
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        // Another key replaces it in one rename, and no partial file stays.
        assert_eq!(apply(&path, Some(OTHER)).unwrap(), Change::Written);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{OTHER}\n")
        );
        assert_eq!(entries(&directory), ["pgcf_user_ca.pub"]);
    }

    #[test]
    fn a_file_with_the_right_key_and_the_wrong_mode_or_kind_is_made_right() {
        let directory = tempdir();
        let path = directory.join("pgcf_user_ca.pub");
        std::fs::write(&path, format!("{KEY}\n")).unwrap();
        for wrong in [0o600, 0o666, 0o664] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(wrong)).unwrap();
            assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Written);
            assert_eq!(mode(&path), 0o644);
        }
        // A link in its place is replaced by a file, and its target is left alone.
        let target = directory.join("elsewhere");
        std::fs::write(&target, "untouched").unwrap();
        std::fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();
        assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Written);
        assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched");
        // Old content with a second line is not what is wanted either.
        std::fs::write(&path, format!("{KEY}\n{OTHER}\n")).unwrap();
        assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Written);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{KEY}\n"));
    }

    #[test]
    fn a_partial_file_a_crash_left_is_replaced_whole() {
        let directory = tempdir();
        let path = directory.join("pgcf_user_ca.pub");
        let partial = directory.join("pgcf_user_ca.pub.partial");
        std::fs::write(&partial, "ssh-ed25519 torn").unwrap();
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(apply(&path, Some(KEY)).unwrap(), Change::Written);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{KEY}\n"));
        assert_eq!(mode(&path), 0o644);
        assert_eq!(entries(&directory), ["pgcf_user_ca.pub"]);
    }

    #[test]
    fn no_key_removes_the_file_and_a_file_that_is_not_there_is_no_change() {
        let directory = tempdir();
        let path = directory.join("pgcf_user_ca.pub");
        assert_eq!(apply(&path, None).unwrap(), Change::Unchanged);
        apply(&path, Some(KEY)).unwrap();
        assert_eq!(apply(&path, None).unwrap(), Change::Removed);
        assert!(!path.exists());
        assert_eq!(apply(&path, None).unwrap(), Change::Unchanged);
        // Whatever else is in the directory stays.
        std::fs::write(directory.join("sshd_config"), "x").unwrap();
        apply(&path, Some(KEY)).unwrap();
        apply(&path, None).unwrap();
        assert_eq!(entries(&directory), ["sshd_config"]);
        // A link is removed, not followed.
        let target = directory.join("elsewhere");
        std::fs::write(&target, "untouched").unwrap();
        symlink(&target, &path).unwrap();
        assert_eq!(apply(&path, None).unwrap(), Change::Removed);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched");
    }

    #[test]
    fn text_that_is_not_one_line_is_refused_and_leaves_the_file_as_it_was() {
        let directory = tempdir();
        let path = directory.join("pgcf_user_ca.pub");
        apply(&path, Some(KEY)).unwrap();
        for broken in [
            "",
            &format!("{KEY}\n{OTHER}"),
            &format!("{KEY}\n"),
            &format!("{KEY}\r"),
            &format!("{KEY}\0"),
            "ssh-ed25519 AAAA\u{e9}",
        ] {
            let error = apply(&path, Some(broken)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{KEY}\n"));
        assert_eq!(entries(&directory), ["pgcf_user_ca.pub"]);
    }

    #[test]
    fn a_directory_that_is_not_there_is_an_error_not_a_made_directory() {
        let directory = tempdir();
        let path = directory.join("missing").join("pgcf_user_ca.pub");
        assert!(apply(&path, Some(KEY)).is_err());
        assert!(!directory.join("missing").exists());
        assert_eq!(apply(&path, None).unwrap(), Change::Unchanged);
    }

    #[test]
    fn the_credentials_carry_the_key_or_not_and_a_change_names_its_event() {
        let with = json!({"revision": 4, "shell_ca_public_key": KEY});
        assert_eq!(key_of(&with), Some(KEY));
        assert_eq!(key_of(&json!({"revision": 4})), None);
        assert_eq!(
            [Change::Written, Change::Removed, Change::Unchanged].map(Change::event),
            [Some("shell_ca_written"), Some("shell_ca_removed"), None]
        );
    }
}
