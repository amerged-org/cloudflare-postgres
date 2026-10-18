// SPDX-License-Identifier: Apache-2.0
//! The upload log of one database's storage generation (plan 7.5): the WAL files the agent has
//! durably in R2, one name per line, fsynced per entry so that it survives an agent restart. The
//! sleep proof reads it: a segment is archived when it is in the log.
use super::protocol::valid_name;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct UploadLog {
    path: PathBuf,
}
impl UploadLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Appends `name` and returns once the entry is on disk.
    pub async fn append(&self, name: &str) -> io::Result<()> {
        if !valid_name(name) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let path = self.path.clone();
        let entry = format!("{name}\n");
        tokio::task::spawn_blocking(move || append_durably(&path, &entry))
            .await
            .map_err(io::Error::other)?
    }
    /// Every complete entry, oldest first.
    pub fn entries(&self) -> io::Result<Vec<String>> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        // Whatever follows the last newline is an entry a crash cut off.
        let complete = text.rfind('\n').map_or("", |end| &text[..end]);
        Ok(complete
            .lines()
            .filter(|line| valid_name(line))
            .map(Into::into)
            .collect())
    }
    pub fn contains(&self, name: &str) -> io::Result<bool> {
        Ok(self.entries()?.iter().any(|entry| entry == name))
    }
    /// The newest WAL segment in the log (not a history, partial or backup file).
    pub fn last_segment(&self) -> io::Result<Option<String>> {
        Ok(self
            .entries()?
            .into_iter()
            .rev()
            .find(|name| name.len() == 24))
    }
}

fn append_durably(path: &Path, entry: &str) -> io::Result<()> {
    use std::{
        fs::OpenOptions,
        io::Write,
        os::unix::fs::{FileExt, OpenOptionsExt},
    };
    let created = !path.exists();
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    // A crash may have cut the last entry off: end it, so that it is not fused with this one.
    let length = file.metadata()?.len();
    let mut last = *b"\n";
    if length > 0 {
        file.read_exact_at(&mut last, length - 1)?;
    }
    if last[0] != b'\n' {
        file.write_all(b"\n")?;
    }
    file.write_all(entry.as_bytes())?;
    file.sync_all()?;
    if created && let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("pgcf-ul-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[tokio::test]
    async fn an_entry_is_in_the_file_when_append_returns_and_survives_a_reopen() {
        let directory = directory("append");
        let log = UploadLog::new(directory.join("log"));
        assert_eq!(log.entries().unwrap(), Vec::<String>::new());
        assert_eq!(log.last_segment().unwrap(), None);
        log.append("000000010000000000000001").await.unwrap();
        log.append("00000002.history").await.unwrap();
        log.append("000000020000000000000002").await.unwrap();
        log.append("000000020000000000000003.partial")
            .await
            .unwrap();
        let text = std::fs::read_to_string(log.path()).unwrap();
        assert_eq!(
            text,
            "000000010000000000000001\n00000002.history\n000000020000000000000002\n000000020000000000000003.partial\n"
        );
        let reopened = UploadLog::new(directory.join("log"));
        assert!(reopened.contains("000000010000000000000001").unwrap());
        assert!(!reopened.contains("000000010000000000000009").unwrap());
        assert_eq!(
            reopened.last_segment().unwrap().as_deref(),
            Some("000000020000000000000002")
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(log.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn a_torn_last_entry_is_ignored_and_never_fused_with_the_next() {
        let directory = directory("torn");
        let path = directory.join("log");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"000000010000000000000001\n0000000100000000000000")
            .unwrap();
        let log = UploadLog::new(&path);
        assert_eq!(log.entries().unwrap(), ["000000010000000000000001"]);
        log.append("000000010000000000000002").await.unwrap();
        assert_eq!(
            log.entries().unwrap(),
            ["000000010000000000000001", "000000010000000000000002"]
        );
    }

    #[tokio::test]
    async fn only_names_postgresql_archives_are_logged() {
        let directory = directory("names");
        let log = UploadLog::new(directory.join("log"));
        for name in [
            "",
            "../x",
            "000000010000000000000001\n000000010000000000000002",
            "RECOVERYXLOG",
        ] {
            assert_eq!(
                log.append(name).await.unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{name:?}"
            );
        }
        assert!(!log.path().exists());
    }
}
