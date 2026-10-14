// SPDX-License-Identifier: Apache-2.0
//! Real Ed25519 authority plus stock PostgreSQL read-only descriptor inspection.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::{pool, qualification};
use pgcf_pool_supervisor::{inspection, now, runtime::Identity};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::CString,
    os::fd::{FromRawFd, OwnedFd},
    path::Path,
};

fn directory(path: &Path) -> OwnedFd {
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let fd = unsafe {
        libc::openat(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    unsafe { OwnedFd::from_raw_fd(fd) }
}
#[test]
fn signed_preparation_reads_real_control_and_does_not_authorize_other_contexts() {
    let root =
        std::env::var("PGCF_TEST_READONLY_ROOT").expect("actual readonly PG fixture required");
    let mut claims = qualification::CONTRACT["fixture"]["claims"].clone();
    let mut preparation = pool::CONTRACT["preparation"].clone();
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .unwrap()
        .trim()
        .to_owned();
    let at = now();
    claims["scope"]["software"]["postgres_image"] = json!(
        "ghcr.io/amerged-org/pgcf-regional@sha256:5495f355719f24bd56219bc46825ecfa8771515a110ceca6e4d83331868bf115"
    );
    claims["scope"]["boot_id"] = json!(boot);
    claims["execution"]["boot_id"] = json!(boot);
    claims["scope_sha256"] = json!(qualification::scope_hash(&claims["scope"]).unwrap());
    claims["challenge"]["scope_sha256"] = claims["scope_sha256"].clone();
    claims["challenge"]["gate"] = json!("host_mount_context");
    claims["challenge"]["issued_at"] = json!(at);
    claims["challenge"]["expires_at"] = json!(at + 30000);
    claims["iat"] = json!(at);
    claims["exp"] = json!(at + 30000);
    preparation["node_id"] = claims["scope"]["node_id"].clone();
    preparation["node_uid"] = claims["scope"]["node_uid"].clone();
    preparation["boot_id"] = json!(boot);
    preparation["qualification_run_id"] = claims["scope"]["run_id"].clone();
    preparation["qualification_scope_sha256"] = claims["scope_sha256"].clone();
    preparation["observed_at"] = json!(at);
    preparation["expires_at"] = json!(at + 30000);
    preparation["policy"]["release_id"] = claims["scope"]["candidate_release_id"].clone();
    for (policy, software) in [
        ("driver_image", "driver_image"),
        ("driver_sha256", "driver_sha256"),
        ("supervisor_image", "supervisor_image"),
        ("supervisor_sha256", "supervisor_sha256"),
        ("archiver_image", "archiver_image"),
        ("host_controller_sha256", "host_controller_sha256"),
    ] {
        preparation["policy"][policy] = claims["scope"]["software"][software].clone();
    }
    preparation["policy"]["archiver_sha256"] = json!(
        claims["scope"]["software"]["archiver_image"]
            .as_str()
            .unwrap()
            .split("@sha256:")
            .nth(1)
            .unwrap()
    );
    let pg = claims["scope"]["software"]["postgres_image"]
        .as_str()
        .unwrap()
        .split("@sha256:")
        .nth(1)
        .unwrap()
        .to_owned();
    preparation["policy"]["class"]["postgres_image_sha256"] = json!(pg);
    let digest = pool::preparation_hash(&preparation).unwrap();
    claims["preparation_sha256"] = json!(digest);
    let key = ring_key();
    let keys = HashMap::from([("native-test".to_owned(), key.1.clone())]);
    let pin = pgcf_pool_supervisor::sha256(
        &serde_json::to_vec(&std::collections::BTreeMap::from([(
            "native-test",
            URL_SAFE_NO_PAD.encode(&key.1),
        )]))
        .unwrap(),
    );
    claims["execution"]["verifier_keys_sha256"] = json!(pin);
    let pod = &preparation["pods"][0];
    let volume = &claims["scope"]["volume"];
    let storage = json!({"backend":"lvm-thin-v1","storage_generation":volume["storage_generation"],"storage_uid":volume["storage_uid"],"namespace_uid":volume["namespace_uid"],"cnpg_cluster_uid":volume["cluster_uid"],"pvc_uid":volume["pvc_uid"],"pv_uid":volume["pv_uid"],"volume_handle":volume["volume_handle"],"volume_group_uuid":volume["volume_group_uuid"],"lv_uuid":volume["lv_uuid"],"thin_id":claims["scope"]["thin_id"],"profile":claims["scope"]["storage"]});
    let mut signal = json!({"v":1,"command":"inspect_readonly","permission":sign(&key.0,&claims),"qualification_run_id":claims["scope"]["run_id"],"qualification_scope_sha256":claims["scope_sha256"],"preparation_sha256":digest,"nonce":claims["challenge"]["nonce"],"database_id":claims["scope"]["database_id"],"source_generation":claims["scope"]["database_generation"].as_u64().unwrap()-1,"configuration_fingerprint":claims["scope"]["configuration_fingerprint"],"node_uid":claims["scope"]["node_uid"],"boot_id":boot,"storage":storage,"pool_namespace":"pgcf-pool","pool_namespace_uid":preparation["pool_namespace_uid"],"pool_pod_uid":pod["pod_uid"],"container_ids":pod["container_ids"],"postgres_image_sha256":pg,"supervisor_sha256":claims["scope"]["software"]["supervisor_sha256"],"issued_at":at,"expires_at":at+30000,"readonly":true,"noload":true});
    let identity = Identity {
        pod: signal["pool_pod_uid"].as_str().unwrap().into(),
        ip: pod["pod_ip"].as_str().unwrap().into(),
        node: signal["node_uid"].as_str().unwrap().into(),
        image: pg,
        executable: signal["supervisor_sha256"].as_str().unwrap().into(),
        key: String::new(),
    };
    let mut reader = pgcf_pool_supervisor::data::ReadonlyReader::default();
    let request = json!({"signal":signal,"preparation":preparation});
    let clean = inspection::inspect(
        &identity,
        &keys,
        &pin,
        &mut reader,
        request.clone(),
        directory(&Path::new(&root).join("clean")),
    )
    .unwrap();
    assert_eq!(clean["control_state"], "shut down");
    assert_eq!(clean["state"], "read");
    let dirty = inspection::inspect(
        &identity,
        &keys,
        &pin,
        &mut reader,
        request.clone(),
        directory(&Path::new(&root).join("dirty")),
    )
    .unwrap();
    assert_eq!(dirty["control_state"], "in production");
    let mut host_changed = request.clone();
    host_changed["preparation"]["policy"]["host_controller_sha256"] = json!("b".repeat(64));
    let digest = pool::preparation_hash(&host_changed["preparation"]).unwrap();
    let mut host_claims = claims.clone();
    host_claims["preparation_sha256"] = json!(digest);
    host_changed["signal"]["preparation_sha256"] = json!(digest);
    host_changed["signal"]["permission"] = json!(sign(&key.0, &host_claims));
    assert!(pool::validate("PoolStorageReadRequest", &host_changed));
    assert!(
        qualification::verify_qualification_permission(
            host_changed["signal"]["permission"].as_str().unwrap(),
            &keys,
            now()
        )
        .is_some()
    );
    assert!(
        matches!(
            inspection::inspect(
                &identity,
                &keys,
                &pin,
                &mut reader,
                host_changed,
                directory(&Path::new(&root).join("clean"))
            ),
            Err(pgcf_pool_supervisor::Error(
                "pool_inspection_software_changed"
            ))
        ),
        "Valid signed preparation with another host ELF pin must be refused"
    );
    let mut changed = request.clone();
    changed["preparation"]["pods"][0]["container_ids"][0] = json!("f".repeat(64));
    assert!(
        inspection::inspect(
            &identity,
            &keys,
            &pin,
            &mut reader,
            changed,
            directory(&Path::new(&root).join("clean"))
        )
        .is_err()
    );
    claims["preparation_sha256"] = Value::Null;
    signal["permission"] = json!(sign(&key.0, &claims));
    assert!(
        inspection::inspect(
            &identity,
            &keys,
            &pin,
            &mut reader,
            json!({"signal":signal,"preparation":request["preparation"]}),
            directory(&Path::new(&root).join("clean"))
        )
        .is_err()
    );
}
fn ring_key() -> (Vec<u8>, Vec<u8>) {
    // Fixed public test key; actual Ed25519 executes, never a product credential.
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let seed = vec![42; 32];
    let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
    (seed, key.public_key().as_ref().to_vec())
}
fn sign(seed: &[u8], claims: &Value) -> String {
    let key = ring::signature::Ed25519KeyPair::from_seed_unchecked(seed).unwrap();
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
    format!(
        "pq1.{body}.{}",
        URL_SAFE_NO_PAD.encode(
            key.sign(format!("pgcf-pool-qualification/v1\n{body}").as_bytes())
                .as_ref()
        )
    )
}
