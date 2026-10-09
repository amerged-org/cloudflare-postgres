// SPDX-License-Identifier: Apache-2.0
//! Only the observed sealed material-revision refresh is hot-reloaded. Runtime identity and trust never change here.
use crate::{controller::SandboxController, policy::Client, slot::Settings};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
    time::Duration,
};
use tokio::sync::watch;
use tonic::Status;
fn invalid() -> Status {
    Status::failed_precondition("sealed_runtime_configuration_transition_invalid")
}
fn normalized(settings: &Settings) -> Result<serde_json::Value, Status> {
    let mut value = serde_json::to_value(settings).map_err(|_| invalid())?;
    value["cloudflare"]["material_revision"] = 0.into();
    if let Some(object) = value["cloudflare"]["storage_authority"].as_object_mut() {
        object.insert("legacy_database_ids".into(), serde_json::json!([]));
    }
    Ok(value)
}
pub fn transition(before: &Settings, after: &Settings) -> Result<(), Status> {
    let previous = before.cloudflare.as_ref().ok_or_else(invalid)?;
    let next = after.cloudflare.as_ref().ok_or_else(invalid)?;
    if next.material_revision < previous.material_revision
        || normalized(before)? != normalized(after)?
    {
        return Err(invalid());
    }
    if let Some(trust) = next.storage_authority.clone() {
        crate::storage::Guard::new(
            trust,
            next.node_uid.clone(),
            u64::from(next.material_revision),
        )?;
    }
    Ok(())
}
fn read(path: &PathBuf) -> Result<Settings, Status> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| invalid())?;
    let meta = file.metadata().map_err(|_| invalid())?;
    if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o777 != 0o600 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 16384 {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
pub async fn run(
    path: PathBuf,
    mut current: Settings,
    controller: SandboxController,
    sender: watch::Sender<Client>,
) {
    loop {
        if let Ok(next) = read(&path)
            && transition(&current, &next).is_ok()
        {
            let old = current.cloudflare.as_ref().unwrap();
            let local = next.cloudflare.as_ref().unwrap();
            if local.material_revision > old.material_revision
                && let Ok(client) = Client::new(local.clone())
                && controller
                    .rebind_material_revision(local.material_revision)
                    .await
                    .is_ok()
            {
                if let Some(guard) = controller.storage_guard() {
                    let legacy = local
                        .storage_authority
                        .as_ref()
                        .map(|trust| trust.legacy_database_ids.as_slice())
                        .unwrap_or(&[]);
                    if guard
                        .lock()
                        .await
                        .rebind_material_revision(u64::from(local.material_revision), legacy)
                        .is_err()
                    {
                        continue;
                    }
                }
                sender.send_replace(client);
                current = next;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Settings {
        let generated: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/compute-pool.generated.json"
        ))
        .unwrap();
        let settings:Settings=serde_json::from_value(serde_json::json!({"socket":"/run/private/controller.sock","state":"/var/lib/private","shim_sockets":"/run/private/s","containerd_socket":"/run/containerd/containerd.sock","containerd_binary":"/bin/containerd","shim_binary":"/bin/shim","runc_binary":"/bin/runc","holder_binary":"/bin/holder","namespace":"k8s.io","slots":0,"slot_lifetime_ms":300000,"cloudflare":{"api_url":"https://api.invalid","agent_key_file":"/private/key","node_id":generated["lease"]["node_id"],"node_uid":generated["lease"]["node_uid"],"region_id":generated["lease"]["region_id"],"material_revision":1,"image":generated["lease"]["policy"]["profile"]["image"],"cgroup_root":"/sys/fs/cgroup/private"}} )).unwrap();
        settings
    }
    #[test]
    fn material_refresh_cannot_change_node_runtime_or_public_trust() {
        let settings = fixture();
        let mut next = settings.clone();
        next.cloudflare.as_mut().unwrap().material_revision = 2;
        assert!(transition(&settings, &next).is_ok());
        let mut changed = next.clone();
        changed.cloudflare.as_mut().unwrap().node_uid = "foreign".into();
        assert!(transition(&settings, &changed).is_err());
        changed = next.clone();
        changed.holder_binary = "/tmp/foreign".into();
        assert!(transition(&settings, &changed).is_err());
        assert!(transition(&next, &settings).is_err());
    }
    #[tokio::test]
    async fn authenticated_file_refresh_keeps_controller_and_guard_instance_alive() {
        use std::{
            fs,
            io::Write,
            os::unix::fs::{OpenOptionsExt, PermissionsExt},
        };
        let suffix = crate::policy::now_ms().rem_euclid(1000000);
        let directory = PathBuf::from(format!("/tmp/pc-{}-{suffix}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let mut settings = fixture();
        settings.state = directory.join("state");
        settings.socket = directory.join("rpc/controller.sock");
        settings.shim_sockets = directory.join("s");
        for path in [
            &settings.state,
            settings.socket.parent().unwrap(),
            &settings.shim_sockets,
        ] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let local = settings.cloudflare.as_mut().unwrap();
        local.agent_key_file = directory.join("key");
        let mut key = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&local.agent_key_file)
            .unwrap();
        write!(key, "pgcf_ak_{}_fixture", local.region_id).unwrap();
        drop(key);
        let keys = std::collections::BTreeMap::from([(
            "cf".to_owned(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        )]);
        use sha2::{Digest, Sha256};
        let sha256 = Sha256::digest(serde_json::to_vec(&keys).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        local.storage_authority = Some(crate::policy::StorageAuthorityTrust {
            keys,
            sha256,
            legacy_database_ids: vec![],
        });
        let client = Client::new(local.clone()).unwrap();
        let path = directory.join("settings.json");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&serde_json::to_vec(&settings).unwrap())
            .unwrap();
        drop(file);
        let controller = SandboxController::prepare(settings.clone()).await.unwrap();
        let original_guard = controller.storage_guard().unwrap();
        let (sender, mut updates) = watch::channel(client);
        let running = tokio::spawn(run(
            path.clone(),
            settings.clone(),
            controller.clone(),
            sender,
        ));
        let mut next = settings;
        next.cloudflare.as_mut().unwrap().material_revision = 2;
        fs::write(&path, serde_json::to_vec(&next).unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), updates.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updates.borrow().local().material_revision, 2);
        assert!(controller.rebind_material_revision(1).await.is_err());
        assert!(!running.is_finished());
        assert!(std::sync::Arc::ptr_eq(
            &original_guard,
            &controller.storage_guard().unwrap()
        ));
        running.abort();
        drop(controller);
        fs::remove_dir_all(directory).unwrap();
    }
}
