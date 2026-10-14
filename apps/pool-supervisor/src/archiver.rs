// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error, private,
    protocol::{self, text},
    s3,
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    process::Command,
    sync::{Mutex, Semaphore},
};

const MAXIMUM: usize = 256 * 1024;
// Stock Barman's list CLI exits zero after skipping unreadable or absent backup.info files.
// Use its unchanged, pinned catalog implementation, but refuse an incomplete directory set.
// A fresh adapter process performs read-only catalog reads and returns the stock JSON shape.
const COMPLETE_CATALOG: &str = r#"
import json, os, sys
from contextlib import closing
from barman.cloud import CloudBackupCatalog
from barman.clients.cloud_backup_list import parse_arguments, get_cloud_interface
config = parse_arguments(sys.argv[1:])
with closing(get_cloud_interface(config)) as cloud:
    catalog = CloudBackupCatalog(cloud_interface=cloud, server_name=config.server_name)
    backups = catalog.get_backup_list()
    directories = {
        os.path.basename(path.rstrip('/'))
        for path in cloud.list_bucket(catalog.prefix + '/') if path.endswith('/')
    }
    if catalog.unreadable_backups or directories != set(backups):
        sys.stderr.write('pgcf_backup_catalog_incomplete\n')
        raise SystemExit(3)
    print(json.dumps({'backups_list': [backups[key].to_json() for key in sorted(backups)]}))
"#;
pub async fn request(value: Value) -> Result<Value, Error> {
    let value = protocol::valid("PoolArchiverCommand", value)?;
    let mut socket = UnixStream::connect(protocol::constant("archiver_socket")?)
        .await
        .map_err(|_| Error("pool_archiver_unavailable"))?;
    let mut bytes = serde_json::to_vec(&value).map_err(|_| Error("pool_request_invalid"))?;
    bytes.push(b'\n');
    socket
        .write_all(&bytes)
        .await
        .map_err(|_| Error("pool_archiver_unavailable"))?;
    socket
        .shutdown()
        .await
        .map_err(|_| Error("pool_archiver_unavailable"))?;
    let mut result = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(3600),
        socket.take(MAXIMUM as u64 + 1).read_to_end(&mut result),
    )
    .await
    .map_err(|_| Error("pool_archiver_result_uncertain"))?
    .map_err(|_| Error("pool_archiver_unavailable"))?;
    if result.len() > MAXIMUM {
        return Err(Error("pool_archiver_reply_oversized"));
    }
    let result: Value =
        serde_json::from_slice(&result).map_err(|_| Error("pool_archiver_reply_invalid"))?;
    if result.get("error").is_some() {
        for code in [
            "pool_backup_report_invalid",
            "pool_backup_catalog_ambiguous",
            "pool_backup_catalog_incomplete",
            "pool_backup_result_uncertain",
            "pool_backup_incomplete",
            "pool_archive_unavailable",
            "pool_archive_client_invalid",
            "pool_archive_connection_unavailable",
            "pool_archive_invalid",
            "pool_archive_ca_unavailable",
            "pool_archive_ca_invalid",
            "pool_archive_credentials_missing",
            "pool_archive_credentials_invalid",
            "pool_archive_command_failed",
            "pool_basebackup_command_failed",
            "pool_retention_command_failed",
            "pool_backup_list_command_failed",
            "pool_archive_command_uncertain",
            "pool_archive_command_unavailable",
            "pool_archive_command_oversized",
            "pool_backup_catalog_unavailable",
            "pool_backup_catalog_invalid",
            "pool_backup_catalog_identity",
            "pool_archive_tls_refused",
            "pool_archive_object_key_refused",
            "pool_archive_auth_refused",
            "pool_wal_identity_changed",
            "pool_archiver_command_invalid",
        ] {
            if result["error"] == code {
                return Err(Error(code));
            }
        }
        return Err(Error("pool_archiver_refused"));
    }
    Ok(result)
}
pub async fn wal(path: &str) -> Result<(), Error> {
    let state: Value = serde_json::from_slice(&private::read(
        Path::new("/pgcf/control/active.json"),
        8192,
    )?)
    .map_err(|_| Error("pool_binding_missing"))?;
    let base = Path::new(protocol::constant("pgdata")?).join("pg_wal");
    let file = Path::new(path)
        .canonicalize()
        .map_err(|_| Error("pool_wal_identity_changed"))?;
    let parent = base
        .canonicalize()
        .map_err(|_| Error("pool_wal_identity_changed"))?;
    if file.parent() != Some(parent.as_path()) || !file.is_file() {
        return Err(Error("pool_wal_identity_changed"));
    }
    let name = file
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or(Error("pool_wal_identity_changed"))?;
    request(json!({"v":1,"command":"wal_archive","binding_id":state["binding_id"],"scope_sha256":state["scope_sha256"],"bundle_nonce":state["bundle_nonce"],"wal_name":name})).await?;
    Ok(())
}
pub struct Archiver {
    configuration: Mutex<Option<Value>>,
    wal: Semaphore,
    backup: Semaphore,
    outcomes: Mutex<HashMap<String, BackupOutcome>>,
}
#[derive(Clone)]
enum BackupOutcome {
    Dispatched,
    Complete(Value),
}
impl Archiver {
    fn new() -> Self {
        Self {
            configuration: Mutex::new(None),
            wal: Semaphore::new(1),
            backup: Semaphore::new(1),
            outcomes: Mutex::new(HashMap::new()),
        }
    }
    async fn execute(&self, command: Value) -> Result<Value, Error> {
        let command = protocol::valid("PoolArchiverCommand", command)?;
        if command["command"] == "configure" {
            let mut current = self.configuration.lock().await;
            if current.as_ref().is_some_and(|v| v != &command) {
                return Err(Error("pool_archive_scope_changed"));
            }
            *current = Some(command);
            return Ok(json!({"accepted":true}));
        }
        let current = self
            .configuration
            .lock()
            .await
            .clone()
            .ok_or(Error("pool_archive_not_configured"))?;
        if !protocol::same(
            &current,
            &command,
            &["binding_id", "scope_sha256", "bundle_nonce"],
        ) {
            return Err(Error("pool_archive_scope_changed"));
        }
        let archive = &current["archive"];
        if command["command"] == "wal_archive" {
            let _permit = self
                .wal
                .acquire()
                .await
                .map_err(|_| Error("pool_archiver_unavailable"))?;
            let path = Path::new(protocol::constant("pgdata")?)
                .join("pg_wal")
                .join(text(&command, "wal_name")?);
            if !path.is_file()
                || path
                    .symlink_metadata()
                    .is_ok_and(|v| v.file_type().is_symlink())
            {
                return Err(Error("pool_wal_identity_changed"));
            }
            run(
                "barman-cloud-wal-archive",
                archive,
                &["--gzip"],
                &[path.to_str().ok_or(Error("pool_wal_identity_changed"))?],
                Duration::from_secs(120),
            )
            .await?;
            return Ok(json!({"archived":true}));
        }
        let name = text(&command, "backup_name")?.to_owned();
        if let Some(BackupOutcome::Complete(report)) = self.outcomes.lock().await.get(&name) {
            return Ok(report.clone());
        }
        let _permit = self
            .backup
            .try_acquire()
            .map_err(|_| Error("pool_backup_in_progress"))?;
        if let Some(BackupOutcome::Complete(report)) = self.outcomes.lock().await.get(&name) {
            return Ok(report.clone());
        }
        let outcomes = self.outcomes.lock().await;
        if outcomes.len() >= 1024 && !outcomes.contains_key(&name) {
            return Err(Error("pool_backup_identity_capacity"));
        }
        drop(outcomes);
        let result = backup(archive, &command, &self.outcomes).await?;
        let mut outcomes = self.outcomes.lock().await;
        outcomes.insert(name, BackupOutcome::Complete(result.clone()));
        Ok(result)
    }
}
async fn run(
    program: &str,
    archive: &Value,
    options: &[&str],
    after: &[&str],
    deadline: Duration,
) -> Result<Vec<u8>, Error> {
    let mut command = if program == "barman-cloud-backup-list" {
        let mut adapter = Command::new("/venv/bin/python3");
        adapter.args(["-c", COMPLETE_CATALOG]);
        adapter
    } else {
        Command::new(format!("/venv/bin/{program}"))
    };
    command
        .args(options)
        .args([
            "--endpoint-url",
            text(archive, "endpoint_url")?,
            "--cloud-provider",
            "aws-s3",
            text(archive, "destination_path")?,
            text(archive, "server_name")?,
        ])
        .args(after)
        .env("AWS_DEFAULT_REGION", "auto")
        .env("PGHOST", "/controller/run")
        .env("PGUSER", "postgres")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| Error("pool_archive_command_unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(Error("pool_archive_command_unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(Error("pool_archive_command_unavailable"))?;
    tokio::time::timeout(deadline, async {
        let mut output = Vec::new();
        let mut diagnostic = Vec::new();
        let mut stdout = stdout.take(4 * 1024 * 1024 + 1);
        let mut stderr = stderr.take(65537);
        let (out, err) = tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut diagnostic)
        );
        out.map_err(|_| Error("pool_archive_command_uncertain"))?;
        err.map_err(|_| Error("pool_archive_command_uncertain"))?;
        if output.len() > 4 * 1024 * 1024 || diagnostic.len() > 65536 {
            return Err(Error("pool_archive_command_oversized"));
        }
        if !child
            .wait()
            .await
            .map_err(|_| Error("pool_archive_command_uncertain"))?
            .success()
        {
            // Return only known constant classes, never upstream exception text or credential data.
            let message = String::from_utf8_lossy(&diagnostic);
            for (pattern, code) in [
                (
                    "pgcf_backup_catalog_incomplete",
                    "pool_backup_catalog_incomplete",
                ),
                ("InvalidObjectName", "pool_archive_object_key_refused"),
                ("SSL validation failed", "pool_archive_tls_refused"),
                ("CERTIFICATE_VERIFY_FAILED", "pool_archive_tls_refused"),
                ("SignatureDoesNotMatch", "pool_archive_auth_refused"),
                ("AccessDenied", "pool_archive_auth_refused"),
                ("NoCredentialsError", "pool_archive_auth_refused"),
            ] {
                if message.contains(pattern) {
                    return Err(Error(code));
                }
            }
            return Err(Error(match program {
                "barman-cloud-backup" => "pool_basebackup_command_failed",
                "barman-cloud-backup-delete" => "pool_retention_command_failed",
                "barman-cloud-backup-list" => "pool_backup_list_command_failed",
                _ => "pool_archive_command_failed",
            }));
        }
        Ok(output)
    })
    .await
    .map_err(|_| Error("pool_archive_command_uncertain"))?
}
async fn named(archive: &Value, name: &str) -> Result<Option<Value>, Error> {
    let output = run(
        "barman-cloud-backup-list",
        archive,
        &["--format", "json"],
        &[],
        Duration::from_secs(120),
    )
    .await?;
    let value: Value =
        serde_json::from_slice(&output).map_err(|_| Error("pool_backup_catalog_invalid"))?;
    let list = value["backups_list"]
        .as_array()
        .ok_or(Error("pool_backup_catalog_invalid"))?;
    let matching: Vec<_> = list.iter().filter(|v| v["backup_name"] == name).collect();
    if matching.len() > 1 {
        return Err(Error("pool_backup_catalog_ambiguous"));
    }
    Ok(matching.first().map(|v| (*v).clone()))
}
async fn backup(
    archive: &Value,
    request: &Value,
    outcomes: &Mutex<HashMap<String, BackupOutcome>>,
) -> Result<Value, Error> {
    let name = text(request, "backup_name")?;
    let info = if let Some(info) = named(archive, name).await? {
        // A retained catalog identity also forbids creating this name again after a read failure.
        outcomes
            .lock()
            .await
            .insert(name.to_owned(), BackupOutcome::Dispatched);
        info
    } else {
        let mut outcomes = outcomes.lock().await;
        if outcomes.contains_key(name) {
            return Err(Error("pool_backup_result_uncertain"));
        }
        // A command with an uncertain result is never repeated under this identity.
        outcomes.insert(name.to_owned(), BackupOutcome::Dispatched);
        drop(outcomes);
        run(
            "barman-cloud-backup",
            archive,
            &["--user", "postgres", "--name", name, "--gzip"],
            &[],
            Duration::from_secs(1800),
        )
        .await?;
        named(archive, name)
            .await?
            .ok_or(Error("pool_backup_catalog_unavailable"))?
    };
    if info["status"] != "DONE" {
        return Err(Error("pool_backup_incomplete"));
    }
    let id = text(&info, "backup_id")?;
    let bytes = s3::catalog(archive, id).await?;
    let raw = std::str::from_utf8(&bytes).map_err(|_| Error("pool_backup_catalog_invalid"))?;
    if !raw.lines().any(|v| v.trim() == "status=DONE")
        || !raw
            .lines()
            .any(|v| v.trim() == format!("backup_name={name}"))
    {
        return Err(Error("pool_backup_catalog_identity"));
    }
    let at = time::OffsetDateTime::parse(
        text(&info, "end_time_iso")?,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| Error("pool_backup_catalog_invalid"))?
    .to_offset(time::UtcOffset::UTC)
    .format(&time::format_description::well_known::Rfc3339)
    .map_err(|_| Error("pool_backup_catalog_invalid"))?;
    let report = protocol::valid(
        "PoolBackupReport",
        json!({"v":1,"binding_id":request["binding_id"],"scope_sha256":request["scope_sha256"],"bundle_nonce":request["bundle_nonce"],"backup_name":name,"state":"DONE","completed_at":at,"catalog_sha256":crate::sha256(&bytes),"bytes":info["size"].as_u64()}),
    )?;
    let days = archive["retention_days"]
        .as_u64()
        .ok_or(Error("pool_archive_invalid"))?;
    run(
        "barman-cloud-backup-delete",
        archive,
        &[
            "--retention-policy",
            &format!("RECOVERY WINDOW OF {days} DAYS"),
        ],
        &[],
        Duration::from_secs(600),
    )
    .await?;
    Ok(report)
}
pub async fn serve() -> Result<(), Error> {
    private::protect_process_memory()?;
    use std::os::unix::fs::PermissionsExt;
    let path = Path::new(protocol::constant("archiver_socket")?);
    let probe = crate::isolation::child()?;
    private::replace(
        Path::new("/controller/run/archiver-isolation.json"),
        &serde_json::to_vec(&probe).map_err(|_| Error("pool_probe_invalid"))?,
    )?;
    private::directory(
        path.parent()
            .ok_or(Error("pool_private_directory_identity"))?,
    )?;
    if path.exists() {
        return Err(Error("pool_archiver_socket_exists"));
    }
    let listener = UnixListener::bind(path).map_err(|_| Error("pool_archiver_unavailable"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| Error("pool_archiver_unavailable"))?;
    let state = Arc::new(Archiver::new());
    let connections = Arc::new(Semaphore::new(16));
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| Error("pool_archiver_unavailable"))?;
        let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
            continue;
        };
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _permit = permit;
            let result = async {
                let credentials = stream
                    .peer_cred()
                    .map_err(|_| Error("pool_archive_peer_refused"))?;
                if credentials.uid() != unsafe { libc::geteuid() } {
                    return Err(Error("pool_archive_peer_refused"));
                }
                let mut bytes = Vec::new();
                tokio::time::timeout(
                    Duration::from_secs(5),
                    (&mut stream)
                        .take(MAXIMUM as u64 + 1)
                        .read_to_end(&mut bytes),
                )
                .await
                .map_err(|_| Error("pool_request_timeout"))?
                .map_err(|_| Error("pool_request_invalid"))?;
                if bytes.len() > MAXIMUM {
                    return Err(Error("pool_request_oversized"));
                }
                let value =
                    serde_json::from_slice(&bytes).map_err(|_| Error("pool_request_invalid"))?;
                state.execute(value).await
            }
            .await;
            let reply = result.unwrap_or_else(|error| json!({"error":error.0}));
            if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                bytes.push(b'\n');
                let _ = stream.write_all(&bytes).await;
            }
        });
    }
}
