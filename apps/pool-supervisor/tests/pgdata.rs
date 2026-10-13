// SPDX-License-Identifier: Apache-2.0
//! Runs inside the pinned PostgreSQL image, against actual engine-created PGDATA.
use pgcf_pool_supervisor::{
    Error,
    data::{control, inspect_clean},
};
use std::{fs, path::PathBuf, process::Command};

fn setup() -> PathBuf {
    let root = PathBuf::from(
        std::env::var("PGCF_TEST_ROOT").expect("real Docker PostgreSQL fixture root required"),
    );
    let path = root.join(format!("pgdata-{}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    assert!(
        Command::new("initdb")
            .args([
                "-D",
                path.to_str().unwrap(),
                "--no-sync",
                "--auth-local=trust",
                "--auth-host=reject"
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    path
}
#[test]
fn actual_postgresql_control_and_markers_refuse_recovery_or_wrong_identity() {
    let path = setup();
    let record = control(&path).unwrap();
    assert_eq!(record.control_state, "shut down");
    inspect_clean(&path, &record.system_identifier, record.timeline).unwrap();
    assert!(matches!(
        inspect_clean(&path, "1", record.timeline),
        Err(Error("pool_data_identity_changed"))
    ));
    fs::write(path.join("standby.signal"), []).unwrap();
    assert!(matches!(
        inspect_clean(&path, &record.system_identifier, record.timeline),
        Err(Error("pool_data_recovery_or_holder"))
    ));
    fs::remove_dir_all(path).unwrap();
}
