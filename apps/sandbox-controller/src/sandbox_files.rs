// SPDX-License-Identifier: Apache-2.0
//! CRI-owned resolver and hostname sources for the qualified Talos/containerd layout.
use crate::cri::PodSandboxConfig;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tonic::Status;

// containerd2.3.6 keeps this CRI plugin directory under its daemon root for compatibility.
// The approved Talos configuration uses the daemon default /var/lib/containerd.
const ROOT: &str = "/var/lib/containerd/io.containerd.grpc.v1.cri";
fn invalid() -> Status {
    Status::failed_precondition("sandbox_system_files_invalid")
}
fn sandbox_directory(root: &Path, id: &str, create: bool) -> Result<Option<PathBuf>, Status> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid());
    }
    for path in [
        root.to_path_buf(),
        root.join("sandboxes"),
        root.join("sandboxes").join(id),
    ] {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                fs::create_dir(&path).map_err(|_| invalid())?;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|_| invalid())?;
            }
            Err(_) => return Err(invalid()),
            Ok(_) => {}
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| invalid())?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
        {
            return Err(invalid());
        }
    }
    Ok(Some(root.join("sandboxes").join(id)))
}
fn remove_created(path: &Path, file: &File) {
    if let (Ok(current), Ok(created)) = (fs::symlink_metadata(path), file.metadata())
        && current.is_file()
        && current.dev() == created.dev()
        && current.ino() == created.ino()
    {
        let _ = fs::remove_file(path);
    }
}
fn write_public(path: &Path, value: &[u8]) -> Result<File, Status> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| invalid())?;
    // These nonsecret CRI files must remain readable by the non-root tenant processes.
    if file
        .set_permissions(fs::Permissions::from_mode(0o644))
        .and_then(|()| file.write_all(value))
        .and_then(|()| file.sync_all())
        .is_err()
    {
        remove_created(path, &file);
        return Err(invalid());
    }
    Ok(file)
}
fn create_at(root: &Path, id: &str, config: &PodSandboxConfig) -> Result<(), Status> {
    let dns = config
        .dns_config
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("CRI_DNS_config_required"))?;
    let mut resolver = String::new();
    // Matches containerd2.3.6 parseDNSOptions, including an explicitly empty DNSConfig.
    if !dns.searches.is_empty() {
        resolver.push_str(&format!("search {}\n", dns.searches.join(" ")));
    }
    for server in &dns.servers {
        resolver.push_str(&format!("nameserver {server}\n"));
    }
    if !dns.options.is_empty() {
        resolver.push_str(&format!("options {}\n", dns.options.join(" ")));
    }
    let directory = sandbox_directory(root, id, true)?.ok_or_else(invalid)?;
    let hostname = directory.join("hostname");
    let resolver_path = directory.join("resolv.conf");
    let hostname_file = write_public(&hostname, format!("{}\n", config.hostname).as_bytes())?;
    if write_public(&resolver_path, resolver.as_bytes()).is_err() {
        // This handle identifies only the just-created file; never remove a pre-existing path.
        remove_created(&hostname, &hostname_file);
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn create(id: &str, config: &PodSandboxConfig) -> Result<(), Status> {
    create_at(Path::new(ROOT), id, config)
}
/// Called only for this controller's assigned sandbox after all child tasks are confirmed deleted.
pub(crate) fn cleanup(id: &str) -> Result<(), Status> {
    let Some(directory) = sandbox_directory(Path::new(ROOT), id, false)? else {
        return Ok(());
    };
    for name in ["hostname", "resolv.conf"] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(invalid()),
            Ok(meta) if meta.is_file() && meta.uid() == unsafe { libc::geteuid() } => {}
            Ok(_) => return Err(invalid()),
        }
        fs::remove_file(path).map_err(|_| invalid())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_missing_dns_and_foreign_sources_without_overwriting_them() {
        let root = std::env::temp_dir().join(format!("pgcf-sandbox-files-{}", std::process::id()));
        assert!(create_at(&root, "../foreign", &PodSandboxConfig::default()).is_err());
        let config = PodSandboxConfig {
            hostname: "database-1".into(),
            dns_config: Some(crate::cri::DnsConfig::default()),
            ..Default::default()
        };
        fs::create_dir(&root).unwrap();
        let directory = sandbox_directory(&root, "owned-pod", true)
            .unwrap()
            .unwrap();
        fs::write(directory.join("hostname"), b"foreign").unwrap();
        assert!(create_at(&root, "owned-pod", &config).is_err());
        assert_eq!(fs::read(directory.join("hostname")).unwrap(), b"foreign");
        assert!(!directory.join("resolv.conf").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
