// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error, archiver, data, now, private,
    protocol::{self, number, text},
};
use pgcf_native_protocol::pool;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub struct Identity {
    pub pod: String,
    pub ip: String,
    pub node: String,
    pub image: String,
    pub executable: String,
    pub key: String,
}
pub struct Runtime {
    pub identity: Identity,
    pub keys: HashMap<String, Vec<u8>>,
    storage_trust: pgcf_native_protocol::storage::StorageTrust,
    mount: Option<Value>,
    bundle: Option<Value>,
    child: Option<Child>,
    started: Option<u64>,
    ready_at: Option<u64>,
    consumed: bool,
    stopped: Option<Value>,
}
impl Runtime {
    pub fn new(
        identity: Identity,
        keys: HashMap<String, Vec<u8>>,
        storage_trust: pgcf_native_protocol::storage::StorageTrust,
    ) -> Self {
        Self {
            identity,
            keys,
            storage_trust,
            mount: None,
            bundle: None,
            child: None,
            started: None,
            ready_at: None,
            consumed: false,
            stopped: None,
        }
    }
    pub fn mounted(&mut self, signal: Value) -> Result<(), Error> {
        let signal = protocol::valid("PoolMountSignal", signal)?;
        let metadata = fs::metadata(protocol::constant("pgdata")?)
            .map_err(|_| Error("pool_data_unavailable"))?;
        if libc::major(metadata.dev()) as u64 != number(&signal, "device_major")?
            || libc::minor(metadata.dev()) as u64 != number(&signal, "device_minor")?
            || number(&signal, "observed_at")? > now() + 5000
        {
            return Err(Error("pool_mount_device_changed"));
        }
        if let Some(old) = &self.mount
            && protocol::same(
                old,
                &signal,
                &[
                    "v",
                    "scope_sha256",
                    "binding_id",
                    "bundle_nonce",
                    "node_uid",
                    "boot_id",
                    "pool_pod_uid",
                    "permission",
                    "mount_id",
                    "device_major",
                    "device_minor",
                ],
            )
        {
            // A notification replay reads the same child; it never creates a new holder or mount.
            return Ok(());
        }
        if self.consumed || self.mount.is_some() {
            return Err(Error("pool_binding_already_consumed"));
        }
        let claims = protocol::permission(text(&signal, "permission")?, &self.keys)?;
        let scope = &claims["scope"];
        self.identity(scope)?;
        protocol::storage_authority(&self.storage_trust, &signal["storage_authority"], scope)?;
        if !protocol::same(
            &signal,
            scope,
            &[
                "binding_id",
                "bundle_nonce",
                "node_uid",
                "boot_id",
                "pool_pod_uid",
            ],
        ) || signal["scope_sha256"] != claims["scope_sha256"]
            || number(&signal, "observed_at")? > now() + 5000
        {
            return Err(Error("pool_mount_scope_changed"));
        }
        self.mount = Some(signal);
        Ok(())
    }
    fn identity(&self, scope: &Value) -> Result<(), Error> {
        if text(scope, "pool_pod_uid")? != self.identity.pod
            || text(scope, "pool_pod_ip")? != self.identity.ip
            || text(scope, "node_uid")? != self.identity.node
            || text(scope, "supervisor_sha256")? != self.identity.executable
            || text(scope, "supervisor_key_sha256")? != self.identity.key
            || text(&scope["class"], "postgres_image_sha256")? != self.identity.image
        {
            return Err(Error("pool_runtime_identity_changed"));
        }
        Ok(())
    }
    pub fn bundle(&mut self, bundle: Value) -> Result<(), Error> {
        let bundle = protocol::valid("PoolTenantBundle", bundle)?;
        self.identity(&bundle["scope"])?;
        protocol::storage_authority(
            &self.storage_trust,
            &bundle["storage_authority"],
            &bundle["scope"],
        )?;
        if pool::scope_hash(&bundle["scope"]).as_deref() != bundle["scope_sha256"].as_str() {
            return Err(Error("pool_scope_hash_changed"));
        }
        if text(&bundle, "tls_server_name")?
            != format!(
                "database-rw.pgcf-db-{}.svc",
                text(&bundle["scope"], "database_id")?
            )
        {
            return Err(Error("pool_tls_identity_changed"));
        }
        if crate::sha256(text(&bundle, "client_ca_pem")?.as_bytes()) != text(&bundle, "ca_sha256")?
        {
            return Err(Error("pool_ca_identity_changed"));
        }
        if let Some(child) = &self.child {
            let old = self.bundle.as_ref().ok_or(Error("pool_binding_missing"))?;
            if !protocol::same(
                old,
                &bundle,
                &["scope", "scope_sha256", "holder_revision", "archive"],
            ) {
                return Err(Error("pool_running_scope_changed"));
            }
            certificates(&bundle)?;
            let pid = child.id();
            if unsafe { libc::kill(pid as i32, libc::SIGHUP) } != 0 {
                return Err(Error("pool_reload_unavailable"));
            }
            self.bundle = Some(bundle);
            return Ok(());
        }
        if self.consumed || self.bundle.is_some() {
            return Err(Error("pool_binding_already_consumed"));
        }
        let claims = protocol::permission(text(&bundle, "permission")?, &self.keys)?;
        if claims["scope"] != bundle["scope"]
            || claims["scope_sha256"] != bundle["scope_sha256"]
            || claims["holder_revision"] != bundle["holder_revision"]
        {
            return Err(Error("pool_permission_scope_changed"));
        }
        self.bundle = Some(bundle);
        Ok(())
    }
    pub async fn start(&mut self) -> Result<Option<Value>, Error> {
        if self.child.is_some() {
            return self.status().map(Some);
        }
        let (Some(mount), Some(bundle)) = (&self.mount, &self.bundle) else {
            return Ok(None);
        };
        if self.consumed
            || mount["permission"] != bundle["permission"]
            || mount["scope_sha256"] != bundle["scope_sha256"]
        {
            return Err(Error("pool_mount_bundle_changed"));
        }
        let claims = protocol::permission(text(bundle, "permission")?, &self.keys)?;
        let scope = &bundle["scope"];
        protocol::storage_authority(&self.storage_trust, &mount["storage_authority"], scope)?;
        protocol::storage_authority(&self.storage_trust, &bundle["storage_authority"], scope)?;
        let path = Path::new(protocol::constant("pgdata")?);
        data::inspect_clean(
            path,
            text(scope, "system_identifier")?,
            number(scope, "timeline")?,
        )?;
        certificates(bundle)?;
        let metadata = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":bundle["scope_sha256"],"bundle_nonce":scope["bundle_nonce"]});
        let configure = json!({"v":1,"command":"configure","binding_id":scope["binding_id"],"scope_sha256":bundle["scope_sha256"],"bundle_nonce":scope["bundle_nonce"],"archive":bundle["archive"]});
        archiver::request(configure).await?;
        private::replace(
            Path::new("/pgcf/control/active.json"),
            &serde_json::to_vec(&metadata).map_err(|_| Error("pool_state_invalid"))?,
        )?;
        if number(&claims, "exp")? <= now() {
            return Err(Error("pool_permission_refused"));
        }
        protocol::storage_authority(&self.storage_trust, &bundle["storage_authority"], scope)?;
        let mut command = Command::new("/usr/lib/postgresql/18/bin/postgres");
        command
            .arg("-D")
            .arg(path)
            .args([
                "-c",
                "archive_command=/pgcf/bin/pgcf-supervisor wal-archive %p",
                "-c",
                "logging_collector=off",
                "-c",
                "log_destination=stderr",
            ])
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        self.started = Some(now());
        self.consumed = true;
        let child = command
            .spawn()
            .map_err(|_| Error("pool_postgres_start_failed"))?;
        let pid = child.id();
        self.child = Some(child);
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if self
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|_| Error("pool_postgres_state_unknown"))?
                .is_some()
            {
                self.child = None;
                return Err(Error("pool_postgres_exited"));
            }
            if data::ready(path, pid) {
                break;
            }
            if Instant::now() >= until {
                self.terminate().await?;
                return Err(Error("pool_postgres_readiness_timeout"));
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        self.ready_at = Some(now());
        self.status().map(Some)
    }
    pub fn authorize(&self, request: &Value) -> Result<(), Error> {
        if !pool::validate("PoolControlRequest", request) {
            return Err(Error("pool_request_invalid"));
        }
        let bundle = self.bundle.as_ref().ok_or(Error("pool_binding_missing"))?;
        if request["binding_id"] != bundle["scope"]["binding_id"]
            || request["bundle_nonce"] != bundle["scope"]["bundle_nonce"]
            || request["scope_sha256"] != bundle["scope_sha256"]
        {
            return Err(Error("pool_control_scope_changed"));
        }
        Ok(())
    }
    pub fn status(&mut self) -> Result<Value, Error> {
        if let Some(report) = &self.stopped {
            return Ok(report.clone());
        }
        let bundle = self.bundle.as_ref().ok_or(Error("pool_binding_missing"))?;
        let child = self
            .child
            .as_mut()
            .ok_or(Error("pool_postgres_not_running"))?;
        if child
            .try_wait()
            .map_err(|_| Error("pool_postgres_state_unknown"))?
            .is_some()
        {
            return Err(Error("pool_postgres_exited"));
        }
        let record = data::control(Path::new(protocol::constant("pgdata")?))?;
        if record.system_identifier != text(&bundle["scope"], "system_identifier")?
            || record.timeline != number(&bundle["scope"], "timeline")?
            || record.control_state != "in production"
        {
            return Err(Error("pool_postgres_identity_changed"));
        }
        let report = json!({"v":1,"binding_id":bundle["scope"]["binding_id"],"scope_sha256":bundle["scope_sha256"],"bundle_nonce":bundle["scope"]["bundle_nonce"],"state":"ready","system_identifier":record.system_identifier,"timeline":record.timeline,"control_state":record.control_state,"postmaster_pid":child.id(),"postgres_started_at":self.started,"readiness_at":self.ready_at,"observed_at":now(),"error":null});
        protocol::valid("PoolSupervisorReport", report)
    }
    pub async fn stop(&mut self, request: &Value) -> Result<Value, Error> {
        self.authorize(request)?;
        if let Some(report) = &self.stopped {
            return Ok(report.clone());
        }
        self.terminate().await?;
        let bundle = self.bundle.as_ref().ok_or(Error("pool_binding_missing"))?;
        let record = data::inspect_clean(
            Path::new(protocol::constant("pgdata")?),
            text(&bundle["scope"], "system_identifier")?,
            number(&bundle["scope"], "timeline")?,
        )?;
        let _ = fs::remove_file("/pgcf/control/active.json");
        let report = protocol::valid(
            "PoolSupervisorReport",
            json!({"v":1,"binding_id":bundle["scope"]["binding_id"],"scope_sha256":bundle["scope_sha256"],"bundle_nonce":bundle["scope"]["bundle_nonce"],"state":"stopped","system_identifier":record.system_identifier,"timeline":record.timeline,"control_state":"shut down","postmaster_pid":null,"postgres_started_at":self.started,"readiness_at":self.ready_at,"observed_at":now(),"error":null}),
        )?;
        self.stopped = Some(report.clone());
        Ok(report)
    }
    pub async fn terminate(&mut self) -> Result<(), Error> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        if unsafe { libc::kill(child.id() as i32, libc::SIGINT) } != 0 {
            return Err(Error("pool_stop_failed"));
        }
        let until = Instant::now() + Duration::from_secs(15);
        while child
            .try_wait()
            .map_err(|_| Error("pool_stop_unknown"))?
            .is_none()
        {
            if Instant::now() >= until {
                return Err(Error("pool_stop_timeout"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.child = None;
        Ok(())
    }
    pub fn check_running(&mut self) -> Result<(), Error> {
        if let Some(child) = self.child.as_mut() {
            if child
                .try_wait()
                .map_err(|_| Error("pool_postgres_state_unknown"))?
                .is_some()
            {
                return Err(Error("pool_postgres_exited"));
            }
        } else if self.consumed && self.stopped.is_none() {
            return Err(Error("pool_postgres_exited"));
        }
        Ok(())
    }
    pub async fn shutdown(&mut self) -> Result<Option<Value>, Error> {
        if let Some(bundle) = &self.bundle
            && (self.child.is_some() || self.stopped.is_some())
        {
            let request = json!({"v":1,"binding_id":bundle["scope"]["binding_id"],"scope_sha256":bundle["scope_sha256"],"bundle_nonce":bundle["scope"]["bundle_nonce"]});
            return self.stop(&request).await.map(Some);
        }
        self.terminate().await?;
        Ok(None)
    }
    pub fn backup_command(&self, request: &Value, name: &str) -> Result<Value, Error> {
        self.authorize(request)?;
        if self.child.is_none() || self.ready_at.is_none() {
            return Err(Error("pool_postgres_not_running"));
        }
        protocol::valid(
            "PoolArchiverCommand",
            json!({"v":1,"command":"backup","binding_id":request["binding_id"],"scope_sha256":request["scope_sha256"],"bundle_nonce":request["bundle_nonce"],"backup_name":name}),
        )
    }
}
fn certificates(bundle: &Value) -> Result<(), Error> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
    let certs = CertificateDer::pem_slice_iter(text(bundle, "server_certificate_pem")?.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error("pool_certificate_invalid"))?;
    let key = PrivateKeyDer::from_pem_slice(text(bundle, "server_private_key_pem")?.as_bytes())
        .map_err(|_| Error("pool_certificate_invalid"))?;
    rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|_| Error("pool_certificate_invalid"))?;
    let root = PathBuf::from("/controller/certificates");
    private::directory(&root)?;
    for (field, name) in [
        ("server_certificate_pem", "server.crt"),
        ("server_private_key_pem", "server.key"),
        ("client_ca_pem", "client-ca.crt"),
    ] {
        private::replace(&root.join(name), text(bundle, field)?.as_bytes())?;
    }
    Ok(())
}
