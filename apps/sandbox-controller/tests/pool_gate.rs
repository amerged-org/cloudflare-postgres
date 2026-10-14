// SPDX-License-Identifier: Apache-2.0
//! Real durable filesystem/lock tests; no CSI/Kubernetes responses are fabricated.
use pgcf_sandbox_controller::pool_gate::{GateRoot, Record};
use std::{fs, os::unix::fs::PermissionsExt};

fn root() -> std::path::PathBuf {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "root-custody fixture requires EUID 0"
    );
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
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
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
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
fn durable_denial_outlives_owner_and_queued_publish_checks_after_lock() {
    let path = root();
    let gate = GateRoot::open(&path).unwrap();
    let handle = "pvc-19d3d080-5b18-480e-8a53-c4c1f2749436";
    let mut lock = gate.lock(handle).unwrap();
    assert!(lock.publish_allowed().unwrap());
    let record = Record::new(handle, &"a".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "queued_publish_process",
            "--ignored",
            "--nocapture",
        ])
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
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
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
#[ignore = "root-custody subprocess helper; invoked only by its owning test"]
fn queued_publish_process() {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "root-custody helper requires EUID 0"
    );
    let path =
        std::env::var("PGCF_GATE_TEST_ROOT").expect("root-custody helper requires its owning test");
    let handle = std::env::var("PGCF_GATE_TEST_HANDLE").unwrap();
    fs::write(std::path::Path::new(&path).join("queued"), b"ready").unwrap();
    let gate = GateRoot::open(std::path::Path::new(&path)).unwrap();
    let locked = gate.lock(&handle).unwrap();
    assert!(!locked.publish_allowed().unwrap());
}

#[test]
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
fn owner_sigkill_does_not_remove_durable_denial() {
    let path = root();
    let handle = "pvc-real-agent-crash";
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "claim_process", "--ignored", "--nocapture"])
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
#[ignore = "root-custody subprocess helper; invoked only by its owning test"]
fn claim_process() {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "root-custody helper requires EUID 0"
    );
    let path =
        std::env::var("PGCF_GATE_TEST_ROOT").expect("root-custody helper requires its owning test");
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
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
fn owned_waiter_has_finite_deadline_without_erasing_custody() {
    let path = root();
    let handle = "pvc-real-lock-deadline";
    let gate = GateRoot::open(&path).unwrap();
    let mut owner = gate.lock(handle).unwrap();
    owner
        .claim(&Record::new(handle, &"d".repeat(64), &format!("LVM-{}", "x".repeat(64))).unwrap())
        .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "bounded_wait_process",
            "--ignored",
            "--nocapture",
        ])
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
#[ignore = "root-custody subprocess helper; invoked only by its owning test"]
fn bounded_wait_process() {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "root-custody helper requires EUID 0"
    );
    let path =
        std::env::var("PGCF_GATE_TEST_ROOT").expect("root-custody helper requires its owning test");
    let handle = std::env::var("PGCF_GATE_TEST_HANDLE").unwrap();
    let gate = GateRoot::open(std::path::Path::new(&path)).unwrap();
    assert!(gate.lock(&handle).is_err());
}

#[test]
#[ignore = "requires root ownership; explicitly executed by the CI root-custody step"]
fn accepted_signed_qualification_hands_the_same_durable_deny_to_the_exact_binding() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use pgcf_native_protocol::{pool, qualification};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::{Value, json};
    use std::{collections::HashMap, os::unix::fs::MetadataExt};

    let pair = Ed25519KeyPair::from_seed_unchecked(&[41; 32]).unwrap();
    let keys = HashMap::from([("native-test".into(), pair.public_key().as_ref().to_vec())]);
    let sign = |prefix: &str, domain: &str, claims: &Value| {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        format!(
            "{prefix}.{payload}.{}",
            URL_SAFE_NO_PAD.encode(pair.sign(format!("{domain}{payload}").as_bytes()).as_ref())
        )
    };
    let mut q = qualification::CONTRACT["fixture"]["claims"].clone();
    let source = q["scope"].clone();
    let physical = json!({"backend":"lvm-thin-v1","storage_generation":source["volume"]["storage_generation"],"storage_uid":source["volume"]["storage_uid"],"namespace_uid":source["volume"]["namespace_uid"],"cnpg_cluster_uid":source["volume"]["cluster_uid"],"pvc_uid":source["volume"]["pvc_uid"],"pv_uid":source["volume"]["pv_uid"],"volume_handle":source["volume"]["volume_handle"],"volume_group_uuid":source["volume"]["volume_group_uuid"],"lv_uuid":source["volume"]["lv_uuid"],"thin_id":source["thin_id"],"profile":source["storage"]});
    let mut scope = pool::CONTRACT["thin_scope"].clone();
    scope["container_ids"]
        .as_array_mut()
        .unwrap()
        .push("2".repeat(64).into());
    for key in [
        "database_id",
        "configuration_fingerprint",
        "region_id",
        "node_id",
        "node_uid",
        "boot_id",
    ] {
        scope[key] = source[key].clone();
    }
    scope["generation"] = source["database_generation"].clone();
    scope["storage"] = physical.clone();
    for key in [
        "driver_image",
        "driver_sha256",
        "supervisor_sha256",
        "host_controller_sha256",
    ] {
        scope[key] = source["software"][key].clone();
    }
    scope["class"]["postgres_image_sha256"] = source["software"]["postgres_image"]
        .as_str()
        .unwrap()
        .split_once("@sha256:")
        .unwrap()
        .1
        .into();
    scope["system_identifier"] = "7412345678901234567".into();
    scope["timeline"] = 1.into();
    let mut prep = pool::CONTRACT["preparation"].clone();
    for key in [
        "node_id",
        "node_uid",
        "boot_id",
        "pool_namespace",
        "pool_namespace_uid",
    ] {
        prep[key] = scope[key].clone();
    }
    prep["qualification_run_id"] = source["run_id"].clone();
    prep["qualification_scope_sha256"] = q["scope_sha256"].clone();
    prep["observed_at"] = 1000.into();
    prep["expires_at"] = 61000.into();
    prep["pods"] = json!([{"pod_uid":scope["pool_pod_uid"],"pod_name":scope["pool_pod_name"],"pod_ip":scope["pool_pod_ip"],"container_ids":scope["container_ids"]}]);
    // Actual controller preparation and node attestation preserve the same full CID set,
    // but their enumeration order is independent. Keep the signed preparation hash exact.
    prep["pods"][0]["container_ids"]
        .as_array_mut()
        .unwrap()
        .reverse();
    prep["policy"]["release_id"] = source["candidate_release_id"].clone();
    prep["policy"]["class"] = scope["class"].clone();
    for key in [
        "driver_image",
        "driver_sha256",
        "supervisor_image",
        "supervisor_sha256",
        "host_controller_sha256",
        "archiver_image",
    ] {
        prep["policy"][key] = source["software"][key].clone();
    }
    prep["policy"]["archiver_sha256"] = source["software"]["archiver_image"]
        .as_str()
        .unwrap()
        .split_once("@sha256:")
        .unwrap()
        .1
        .into();
    q["preparation_sha256"] = pool::preparation_hash(&prep).unwrap().into();
    q["challenge"]["gate"] = "single_writer".into();
    q["challenge"]["sequence"] = 3.into();
    let old_execution = q["execution"].clone();
    q["execution"]["driver_pod_uid"] = "00000000-0000-4000-8000-000000000100".into();
    let bind = json!({"v":1,"kid":"native-test","scope":scope,"scope_sha256":pool::scope_hash(&scope).unwrap(),"holder_revision":1,"iat":1000,"exp":31000});
    let permission = sign("pb1", "pgcf-pool-bind/v1\n", &bind);
    let desired = json!({"binding":{"v":1,"scope":scope,"scope_sha256":bind["scope_sha256"],"holder_revision":1,"state":"claimed","created_at":1000,"updated_at":1000},"authority":"current","permission":permission,"storage_authority":null});
    let path = root();
    let gate = GateRoot::open(&path).unwrap();
    let handle = source["volume"]["volume_handle"].as_str().unwrap();
    let uuid = format!(
        "LVM-{}{}",
        source["volume"]["volume_group_uuid"]
            .as_str()
            .unwrap()
            .replace('-', ""),
        source["volume"]["lv_uuid"]
            .as_str()
            .unwrap()
            .replace('-', "")
    );
    let old = Record::new(handle, q["scope_sha256"].as_str().unwrap(), &uuid).unwrap();
    let next = Record::new(handle, bind["scope_sha256"].as_str().unwrap(), &uuid).unwrap();
    let mut lock = gate.lock(handle).unwrap();
    lock.claim(&old).unwrap();
    let original = fs::read(lock.record_path()).unwrap();
    let inode = fs::metadata(lock.record_path()).unwrap().ino();
    let stamp = pgcf_sandbox_controller::pool_gate::digest(&original);
    let host = json!({"gate":"host_mount_context","kernel_version":source["software"]["kernel_version"],"caller_pid_namespace_inode":0xeffffffcu64,"initial_pid_namespace_inode":0xeffffffcu64,"caller_user_namespace_inode":0xeffffffdu64,"initial_user_namespace_inode":0xeffffffdu64,"next_namespace_errno":2,"storage_read":{"v":1,"command":"inspect_readonly","qualification_run_id":source["run_id"],"qualification_scope_sha256":q["scope_sha256"],"preparation_sha256":q["preparation_sha256"],"nonce_sha256":"a".repeat(64),"database_id":source["database_id"],"source_generation":1,"node_uid":source["node_uid"],"boot_id":source["boot_id"],"pool_pod_uid":scope["pool_pod_uid"],"postgres_image_sha256":scope["class"]["postgres_image_sha256"],"device_major":253,"device_minor":2,"state":"read","system_identifier":scope["system_identifier"],"timeline":scope["timeline"],"control_state":"shut down","observed_at":1000,"error":null},"storage_observation":{"v":1,"database_id":source["database_id"],"generation":1,"node_uid":source["node_uid"],"boot_id":source["boot_id"],"storage":physical,"kernel_proof":{"device_major":253,"device_minor":2,"mount_id":null,"dm_open_count":0,"foreign_mounts":0,"complete_namespace_scan":false,"named_namespace_scan_complete":true,"zero_before_bind":true,"exclusive_superblock_creation":false,"nonlazy_unmount_verified":true,"never_attached_verified":false,"creator_fence":null,"mountpoint":null},"observed_at":1000}});
    let finite = json!({"gate":"finite_creator_fence","binding_id":null,"source_generation":1,"volume_handle":handle,"driver_sha256":source["software"]["driver_sha256"],"deny_record_inode_before_restart":inode,"deny_record_inode_after_restart":inode,"deny_record_sha256_before_restart":stamp,"deny_record_sha256_after_restart":stamp,"deny_record_scope_sha256":q["scope_sha256"],"deny_record_fsync_errno":0,"driver_restarts":1,"driver_pod_uid_before_restart":old_execution["driver_pod_uid"],"driver_pod_uid_after_restart":q["execution"]["driver_pod_uid"],"driver_daemonset_uid":source["node_uid"],"driver_image":source["software"]["driver_image"],"driver_deleted_at":1000,"driver_replacement_ready_at":1000,"agent_owner_deaths":1,"before_claim_requests_completed":1,"denied_operations":[{"operation":"node_publish","grpc_status":9,"message":"pool_creator_fence_denied"},{"operation":"node_expand","grpc_status":9,"message":"pool_creator_fence_denied"},{"operation":"volume_reconcile","error":"pool_creator_fence_denied"},{"operation":"snapshot_create","error":"pool_creator_fence_denied","snapshot_uid":source["node_uid"],"source_volume_handle":handle,"state_at_denial":"Pending","requested_at":1000,"deleted_at":1000,"absent_at":1000}],"surviving_creation_descriptors":0,"final_dm_open_count":0,"physical_snapshot_count":0,"physical_observed_at":1000,"progress_sha256":q["progress_sha256"],"device_major":253,"device_minor":2});
    let evidence = |sequence: u64, execution: &Value, measurement: Value| json!({"sequence":sequence,"producer":"node_agent","issued_at":1000,"started_at":1000,"observed_at":1000,"received_at":1000,"execution":execution,"measurement":measurement});
    let input = json!({"scope":source,"scope_sha256":q["scope_sha256"],"status":"running","expires_at":61000,"challenge":q["challenge"],"permission":sign("pq1","pgcf-pool-qualification/v1\n",&q),"policy":null,"accepted_evidence":[evidence(1,&old_execution,host),evidence(2,&q["execution"],finite)],"accepted_sleep":null,"pending_progress":[]});
    assert!(qualification::validate(
        "PostgresPoolQualificationInput",
        &input
    ));
    assert!(
        pool::verify_permission(desired["permission"].as_str().unwrap(), &keys, 1000).is_some()
    );
    assert!(
        qualification::verify_qualification_permission(
            input["permission"].as_str().unwrap(),
            &keys,
            1000
        )
        .is_some()
    );
    let mut missing = input.clone();
    missing["accepted_evidence"].as_array_mut().unwrap().pop();
    assert!(
        lock.claim_qualified(&next, &desired, &missing, &prep, &keys, 1000)
            .is_err()
    );
    assert_eq!(fs::read(lock.record_path()).unwrap(), original);
    let mut newer = bind.clone();
    newer["scope"]["generation"] = 3.into();
    newer["scope_sha256"] = pool::scope_hash(&newer["scope"]).unwrap().into();
    let mut next_desired = desired.clone();
    next_desired["binding"]["scope"] = newer["scope"].clone();
    next_desired["binding"]["scope_sha256"] = newer["scope_sha256"].clone();
    next_desired["permission"] = sign("pb1", "pgcf-pool-bind/v1\n", &newer).into();
    let wrong = Record::new(handle, newer["scope_sha256"].as_str().unwrap(), &uuid).unwrap();
    assert!(
        lock.claim_qualified(&wrong, &next_desired, &input, &prep, &keys, 1000)
            .is_err()
    );
    assert_eq!(fs::read(lock.record_path()).unwrap(), original);
    let mut recreated = input.clone();
    recreated["accepted_evidence"][1]["measurement"]["deny_record_inode_before_restart"] =
        (inode + 1).into();
    recreated["accepted_evidence"][1]["measurement"]["deny_record_inode_after_restart"] =
        (inode + 1).into();
    assert!(
        lock.claim_qualified(&next, &desired, &recreated, &prep, &keys, 1000)
            .is_err()
    );
    assert_eq!(fs::read(lock.record_path()).unwrap(), original);
    let lock_path = path.join(format!(
        "{}.lock",
        pgcf_sandbox_controller::pool_gate::digest(handle.as_bytes())
    ));
    let lock_inode = fs::metadata(&lock_path).unwrap().ino();
    assert!(
        lock.claim_qualified(&next, &desired, &input, &prep, &keys, 1000)
            .is_ok(),
        "accepted Q custody must hand off without clearing its durable deny"
    );
    assert_eq!(fs::metadata(lock_path).unwrap().ino(), lock_inode);
    assert_eq!(
        serde_json::from_slice::<Record>(&fs::read(lock.record_path()).unwrap()).unwrap(),
        next
    );
    assert!(!lock.publish_allowed().unwrap());
    drop(lock);
    fs::remove_dir_all(path).unwrap();
}
