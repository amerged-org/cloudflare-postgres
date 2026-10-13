// SPDX-License-Identifier: Apache-2.0
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    process::{Command, Stdio},
};

#[test]
fn feature_off_refuses_serving_and_installer_copies_only_once() {
    let binary = env!("CARGO_BIN_EXE_pgcf-pool-supervisor");
    let status = Command::new(binary)
        .arg("serve")
        .env_remove("PGCF_POOL_ENABLED")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "default-off must not launch an endpoint or PostgreSQL"
    );
    let root = std::env::temp_dir().join(format!("pgcf-pool-install-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join("pgcf-supervisor");
    assert!(
        Command::new(binary)
            .arg("install")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let installed = fs::metadata(&path).unwrap();
    assert_eq!(installed.mode() & 0o777, 0o555);
    assert_eq!(fs::read(binary).unwrap(), fs::read(&path).unwrap());
    assert!(
        !Command::new(binary)
            .arg("install")
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    fs::remove_dir_all(root).unwrap();
}
