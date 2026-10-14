// SPDX-License-Identifier: Apache-2.0
//! Real durable filesystem/lock tests; no CSI/Kubernetes responses are fabricated.
use pgcf_sandbox_controller::pool_gate::{GateRoot, Record};
use std::{fs, os::unix::fs::PermissionsExt};

fn root() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pgcf-pool-gate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[test]
fn host_start_provisions_missing_custody_before_first_csi_publish() {
    use std::os::unix::fs::MetadataExt;
    let parent = root();
    let path = parent.join("gates");
    assert!(!path.exists());
    let gate = GateRoot::provision(&path).unwrap();
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.uid(), 0);
    assert_eq!(metadata.mode() & 0o7777, 0o700);
    let handle = "pvc-real-first-host-start";
    let mut lock = gate.lock(handle).unwrap();
    lock.claim(&Record::new(handle, &"e".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap())
        .unwrap();
    drop(lock);
    drop(gate);
    let restarted = GateRoot::provision(&path).unwrap();
    assert!(!restarted.lock(handle).unwrap().publish_allowed().unwrap());
    drop(restarted);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(GateRoot::provision(&path).is_err());
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o755);
    let alias = parent.join("alias");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(GateRoot::provision(&alias).is_err());
    let unsafe_parent = parent.join("mutable");
    fs::create_dir(&unsafe_parent).unwrap();
    fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(GateRoot::provision(&unsafe_parent.join("gates")).is_err());
    assert!(!unsafe_parent.join("gates").exists());
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn durable_denial_outlives_owner_and_queued_publish_checks_after_lock() {
    let path = root();
    let gate = GateRoot::open(&path).unwrap();
    let handle = "pvc-19d3d080-5b18-480e-8a53-c4c1f2749436";
    let mut lock = gate.lock(handle).unwrap();
    assert!(lock.publish_allowed().unwrap());
    let record = Record::new(handle, &"a".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "queued_publish_process", "--nocapture"])
        .env("PGCF_GATE_TEST_ROOT", &path)
        .env("PGCF_GATE_TEST_HANDLE", handle)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !path.join("queued").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(child.try_wait().unwrap().is_none());
    lock.claim(&record).unwrap();
    drop(lock); // owner exit releases flock, never the durable denial
    assert!(child.wait().unwrap().success());
    let restarted = gate.lock(handle).unwrap();
    assert!(!restarted.publish_allowed().unwrap());
    drop(restarted);
    // A different scope cannot overwrite/adopt an existing denial.
    let mut lock = gate.lock(handle).unwrap();
    assert!(
        lock.claim(
            &Record::new(handle, &"b".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap()
        )
        .is_err()
    );
    drop(lock);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn malformed_record_and_symlink_are_denials() {
    let path = root();
    let gate = GateRoot::open(&path).unwrap();
    let handle = "pvc-real-refusal";
    let lock = gate.lock(handle).unwrap();
    fs::write(lock.record_path(), b"truncated").unwrap();
    assert!(!lock.publish_allowed().unwrap());
    fs::remove_file(lock.record_path()).unwrap();
    std::os::unix::fs::symlink("/does-not-exist", lock.record_path()).unwrap();
    assert!(!lock.publish_allowed().unwrap());
    drop(lock);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn queued_publish_process() {
    let Ok(path) = std::env::var("PGCF_GATE_TEST_ROOT") else {
        return;
    };
    let handle = std::env::var("PGCF_GATE_TEST_HANDLE").unwrap();
    fs::write(std::path::Path::new(&path).join("queued"), b"ready").unwrap();
    let gate = GateRoot::open(std::path::Path::new(&path)).unwrap();
    let locked = gate.lock(&handle).unwrap();
    assert!(!locked.publish_allowed().unwrap());
}

#[test]
fn owner_sigkill_does_not_remove_durable_denial() {
    let path = root();
    let handle = "pvc-real-agent-crash";
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "claim_process", "--nocapture"])
        .env("PGCF_GATE_TEST_ROOT", &path)
        .env("PGCF_GATE_TEST_HANDLE", handle)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !path.join("claimed").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let gate = GateRoot::open(&path).unwrap();
    let restarted = gate.lock(handle).unwrap();
    assert!(!restarted.publish_allowed().unwrap());
    drop(restarted);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn claim_process() {
    let Ok(path) = std::env::var("PGCF_GATE_TEST_ROOT") else {
        return;
    };
    let handle = std::env::var("PGCF_GATE_TEST_HANDLE").unwrap();
    let gate = GateRoot::open(std::path::Path::new(&path)).unwrap();
    let mut locked = gate.lock(&handle).unwrap();
    locked
        .claim(&Record::new(&handle, &"c".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap())
        .unwrap();
    fs::write(std::path::Path::new(&path).join("claimed"), b"ready").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}

#[test]
fn owned_waiter_has_finite_deadline_without_erasing_custody() {
    let path = root();
    let handle = "pvc-real-lock-deadline";
    let gate = GateRoot::open(&path).unwrap();
    let mut owner = gate.lock(handle).unwrap();
    owner
        .claim(&Record::new(handle, &"d".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap())
        .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "bounded_wait_process", "--nocapture"])
        .env("PGCF_GATE_TEST_ROOT", &path)
        .env("PGCF_GATE_TEST_HANDLE", handle)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(7);
    let finished = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status.success();
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert!(!owner.publish_allowed().unwrap());
    drop(owner);
    fs::remove_dir_all(path).unwrap();
    assert!(
        finished,
        "an owned waiter must return a scoped refusal before the fixed deadline"
    );
}
#[test]
fn bounded_wait_process() {
    let Ok(path) = std::env::var("PGCF_GATE_TEST_ROOT") else {
        return;
    };
    let handle = std::env::var("PGCF_GATE_TEST_HANDLE").unwrap();
    let gate = GateRoot::open(std::path::Path::new(&path)).unwrap();
    assert!(gate.lock(&handle).is_err());
}
