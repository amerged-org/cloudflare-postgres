// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

/// Keep the trusted holder's memory and environment inaccessible to same-UID workload children.
/// This must run before creating its control key or accepting tenant/archive configuration.
pub fn protect_process_memory() -> Result<(), Error> {
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } != 0
    {
        return Err(Error("pool_process_custody_refused"));
    }
    Ok(())
}

pub fn directory(path: &Path) -> Result<(), Error> {
    fs::create_dir_all(path).map_err(|_| Error("pool_private_directory_unavailable"))?;
    let meta =
        fs::symlink_metadata(path).map_err(|_| Error("pool_private_directory_unavailable"))?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(Error("pool_private_directory_identity"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| Error("pool_private_directory_unavailable"))
}
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or(Error("pool_private_directory_identity"))?;
    directory(parent)?;
    let temp = parent.join(format!(
        ".{}-{}.tmp",
        path.file_name()
            .and_then(|v| v.to_str())
            .ok_or(Error("pool_private_file_identity"))?,
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|_| Error("pool_private_file_unavailable"))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|_| Error("pool_private_file_unavailable"))?;
        file.sync_all()
            .map_err(|_| Error("pool_private_file_unavailable"))?;
        fs::rename(&temp, path).map_err(|_| Error("pool_private_file_unavailable"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn read(path: &Path, maximum: usize) -> Result<Vec<u8>, Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error("pool_private_file_unavailable"))?;
    let meta = file
        .metadata()
        .map_err(|_| Error("pool_private_file_unavailable"))?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > maximum as u64
    {
        return Err(Error("pool_private_file_identity"));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error("pool_private_file_unavailable"))?;
    if bytes.len() > maximum {
        return Err(Error("pool_private_file_identity"));
    }
    Ok(bytes)
}
