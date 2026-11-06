// SPDX-License-Identifier: Apache-2.0
//! Isolated, operation-owned archive verification. These instances never enter the gateway's
//! database table, carry a tenant route, dispatch events or write the source archive. A durable
//! journal precedes creating resources; a successful receipt precedes their removal. The original
//! database's volume is never removed here: only Cloudflare's later superseded order may do that.
use super::{Core, Phase, build::write_owned, job_database};
use crate::{
    admission::Request as AdmissionRequest,
    archive::{
        facts,
        recovery::Restored,
        restore::{End, Failed},
        verify::{self, Verifier},
    },
    credentials::Access,
    link::file::{create_private_directory, sync_directory, write_private},
    machine::{Account, Machine},
    postgres, settings, sleep,
    state::{ProvenSleepRecord, Resources},
    storage::{Removal, VolumeId},
    units::{
        limits::{Io, Limits},
        slots::Bind,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
pub(crate) struct VerificationCancellation {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}
impl VerificationCancellation {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }
    async fn wait(&self) {
        if !self.cancelled.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }
}

#[derive(Deserialize)]
struct Source {
    path: String,
    backup_id: String,
    end: ProvenSleepRecord,
}
#[derive(Deserialize)]
struct Settings {
    max_connections: u32,
    archive_timeout_seconds: u32,
}
#[derive(Deserialize)]
struct Request {
    operation: String,
    database_id: String,
    source_generation: u64,
    source_storage_generation: u64,
    inventory_sha256: String,
    source: Source,
    resources: Resources,
    settings: Settings,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// A renewable credential reference is transport material, not part of the immutable restore
/// authority. Its scoped path, database, backup, proof and resource settings remain bound.
fn request_identity(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(source) = value.get_mut("source").and_then(Value::as_object_mut) {
        source.remove("credential");
    }
    value
}
fn request_digest(value: &Value) -> String {
    digest(request_identity(value).to_string().as_bytes())
}

/// The leading letter makes this a valid runtime ID. Its operation binding is checked before any
/// resource is touched, including when a journal is read after a crash.
fn runtime_id(request: &Value) -> String {
    format!(
        "v{}",
        &digest(format!("{}:{}", request["operation"], request["database_id"]).as_bytes())[..19]
    )
}
fn result(request: &Request, receipt: &Value, cleaned_up: bool) -> Value {
    let mut result = json!({
        "operation": request.operation, "database_id": request.database_id,
        "source_generation": request.source_generation,
        "source_storage_generation": request.source_storage_generation,
        "inventory_sha256": request.inventory_sha256,
        "observed_at": facts::timestamp(super::now_ms()), "cleaned_up": cleaned_up,
    });
    if cleaned_up && receipt.get("system_identifier").is_some() {
        result["status"] = json!("verified");
        result["system_identifier"] = receipt["system_identifier"].clone();
        result["timeline"] = receipt["timeline"].clone();
        result["backup_id"] = json!(request.source.backup_id);
        result["end"] = request.source.end.observation();
    } else {
        result["status"] = json!("failed");
        result["reason"] = if cleaned_up {
            receipt["failure"].as_str().unwrap_or("verification_failed")
        } else {
            "verification_cleanup_pending"
        }
        .into();
    }
    result
}

const CANCELLATION_FIELDS: [&str; 5] = [
    "operation",
    "database_id",
    "source_generation",
    "source_storage_generation",
    "inventory_sha256",
];
fn cancellation_binding(value: &Value) -> Value {
    Value::Object(
        CANCELLATION_FIELDS
            .into_iter()
            .map(|key| (key.to_string(), value[key].clone()))
            .collect(),
    )
}
fn cancellation_result(value: &Value, cleaned: bool, reason: &str) -> Value {
    let mut result = cancellation_binding(value);
    result["status"] = json!("failed");
    result["observed_at"] = json!(facts::timestamp(super::now_ms()));
    result["cleaned_up"] = cleaned.into();
    result["reason"] = reason.into();
    result
}

impl<M: Machine> Core<M> {
    fn verification_directory(&self) -> PathBuf {
        self.layout().agent().join("archive-verifications")
    }

    /// True only after the exact scratch resources are absent. A failure leaves the journal and
    /// physical accounting intact; another page or a restarted agent continues this cleanup.
    async fn clean_verification(&self, runtime: &str) -> bool {
        if self.find(runtime).is_some() {
            return false;
        }
        let Ok(volume) = VolumeId::new(runtime, 1) else {
            return false;
        };
        if self.machine.stop(runtime).await.is_err() {
            return false;
        }
        if self
            .machine
            .unit(runtime)
            .await
            .map_or(true, |unit| unit.active.awake())
        {
            return false;
        }
        // Retire the registration and drain even already-cloned handlers before enumerating
        // jobs: a WAL fetch queued for a semaphore must never start after cleanup was acknowledged.
        self.table.remove_and_drain(runtime).await;
        // A dropped systemd-run client does not stop its transient service. Stop every exact
        // operation-owned Barman unit before a volume/account can be declared absent.
        for kind in [
            crate::archive::job::Kind::BackupList,
            crate::archive::job::Kind::Restore,
            crate::archive::job::Kind::WalFetch,
            crate::archive::job::Kind::WalArchive,
            crate::archive::job::Kind::BaseBackup,
        ] {
            if self.jobs.stop_earlier(runtime, kind).await.is_err() {
                return false;
            }
        }
        self.admission.stopped(runtime);
        if let Some(permit) = self
            .resumed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(runtime)
        {
            permit.failed();
        }
        if self
            .machine
            .remove_volume(
                &volume,
                Removal::DatabaseDeleted {
                    storage_generation: 1,
                },
            )
            .await
            .is_err()
            || !matches!(self.machine.has_volume(&volume).await, Ok(false))
        {
            return false;
        }
        if let Err(error) = std::fs::remove_dir_all(self.layout().socket_directory(runtime))
            && error.kind() != io::ErrorKind::NotFound
        {
            return false;
        }
        self.machine.remove_account(runtime).await.is_ok()
            && self.machine.account(runtime).is_none()
    }

    /// Removes abandoned scratch work after a full desired pull. No deletion is authorized by a
    /// runtime name alone: only a private journal whose request deterministically owns it counts.
    pub(crate) async fn cleanup_archive_verifications(
        &self,
        active: &HashSet<String>,
        running: &HashSet<String>,
    ) {
        let directory = self.verification_directory();
        let Ok(files) = std::fs::read_dir(&directory) else {
            return;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(journal) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if let Some(cancellation) = journal.get("cancellation") {
                if journal["result"]["cleaned_up"] != true {
                    self.report_archive_verification(
                        self.cancel_archive_verification(cancellation).await,
                    );
                } else if journal["acknowledged"] != true {
                    self.report_archive_verification(journal["result"].clone());
                }
                continue;
            }
            let request = &journal["request"];
            let Some(operation) = request["operation"].as_str() else {
                continue;
            };
            if active.contains(operation) || running.contains(operation) {
                continue;
            }
            if !crate::node_link::contract_valid("ArchiveVerificationRequest", request)
                || journal["request_sha256"] != request_digest(request)
                || journal["runtime"] != runtime_id(request)
            {
                continue;
            }
            if self.clean_verification(&runtime_id(request)).await {
                if journal["acknowledged"] == true && journal["cleaned_up"] == true {
                    if let Ok(parsed) = serde_json::from_value::<Request>(request.clone()) {
                        let completed = json!({"version":1,"request_sha256":request_digest(request),"runtime":runtime_id(request),"result":result(&parsed,&journal["receipt"],true)});
                        let completed_path = directory.join(format!("{operation}.completed.json"));
                        // Retire the operation durably before dropping the full journal. A late
                        // desired page must not recreate scratch work after its pin was released.
                        if write_private(&completed_path, completed.to_string().as_bytes()).is_ok()
                        {
                            let _ = std::fs::remove_file(&path);
                            let _ = sync_directory(&directory);
                        }
                    }
                } else if let Ok(parsed) = serde_json::from_value::<Request>(request.clone()) {
                    let mut journal = journal.clone();
                    if journal["receipt"].is_null() {
                        journal["receipt"] = json!({"failure":"archive_cancelled"});
                    }
                    journal["cleaned_up"] = true.into();
                    if write_private(&path, journal.to_string().as_bytes()).is_ok() {
                        self.report_archive_verification(result(
                            &parsed,
                            &journal["receipt"],
                            true,
                        ));
                    }
                }
            }
        }
    }

    /// Task absence cancels work; it is not a receipt acknowledgment. Only the successful POST
    /// of this exact cleaned-up result authorizes journal removal on a later complete pull.
    pub(crate) fn archive_verification_posted(&self, answer: &Value) {
        if answer["cleaned_up"] != true {
            return;
        }
        let Some(operation) = answer["operation"].as_str() else {
            return;
        };
        if !pgcf_native_protocol::valid_pattern("operation", operation) {
            return;
        }
        let cancelled_path = self.cancellation_path(operation);
        if let Ok(bytes) = std::fs::read(&cancelled_path)
            && let Ok(mut held) = serde_json::from_slice::<Value>(&bytes)
            && held["result"]["cleaned_up"] == true
            && cancellation_binding(answer) == held["cancellation"]
        {
            held["acknowledged"] = true.into();
            let _ = write_private(&cancelled_path, held.to_string().as_bytes());
        }
        let path = self
            .verification_directory()
            .join(format!("{operation}.json"));
        let Ok(bytes) = std::fs::read(&path) else {
            return;
        };
        let Ok(mut journal) = serde_json::from_slice::<Value>(&bytes) else {
            return;
        };
        if journal["cleaned_up"] != true {
            return;
        }
        let request = &journal["request"];
        if [
            "operation",
            "database_id",
            "source_generation",
            "source_storage_generation",
            "inventory_sha256",
        ]
        .into_iter()
        .any(|key| request[key] != answer[key])
        {
            return;
        }
        let Ok(parsed) = serde_json::from_value::<Request>(request.clone()) else {
            return;
        };
        let mut expected = result(&parsed, &journal["receipt"], true);
        let mut actual = answer.clone();
        expected
            .as_object_mut()
            .expect("receipt object")
            .remove("observed_at");
        let Some(actual) = actual.as_object_mut() else {
            return;
        };
        actual.remove("observed_at");
        if expected.as_object() != Some(actual) {
            return;
        }
        journal["acknowledged"] = true.into();
        let _ = write_private(&path, journal.to_string().as_bytes());
    }

    async fn refuse_verification(&self, request: &Request, value: &Value, reason: &str) -> Value {
        let runtime = runtime_id(value);
        let path = self
            .verification_directory()
            .join(format!("{}.json", request.operation));
        let cleaned = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(mut journal)
                    if request_identity(&journal["request"]) == request_identity(value)
                        && journal["runtime"] == runtime
                        && journal["request_sha256"] == request_digest(value) =>
                {
                    let cleaned = self.clean_verification(&runtime).await;
                    journal["receipt"] = json!({"failure":reason});
                    journal["acknowledged"] = false.into();
                    journal["cleaned_up"] = cleaned.into();
                    write_private(&path, journal.to_string().as_bytes()).is_ok() && cleaned
                }
                _ => false,
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let volume = VolumeId::new(&runtime, 1).expect("derived runtime ID");
                let absent = matches!(self.machine.has_volume(&volume).await, Ok(false))
                    && self.machine.account(&runtime).is_none()
                    && self
                        .machine
                        .unit(&runtime)
                        .await
                        .is_ok_and(|unit| !unit.active.awake())
                    && matches!(self.jobs.absent(&runtime).await, Ok(true));
                if !absent {
                    false
                } else {
                    let journal = json!({"version":1,"runtime":runtime,"request":value,"request_sha256":request_digest(value),"receipt":{"failure":reason},"cleaned_up":true,"acknowledged":false});
                    create_private_directory(&self.verification_directory()).is_ok()
                        && write_private(&path, journal.to_string().as_bytes()).is_ok()
                }
            }
            Err(_) => false,
        };
        result(request, &json!({"failure":reason}), cleaned)
    }

    /// Runtime accounting stays in the ordinary admission snapshot, but these operation-owned
    /// instances are explicitly distinguished from customer databases in the node sample.
    pub(crate) fn verification_runtime_ids(&self, awake: &[String]) -> Vec<String> {
        let Ok(files) = std::fs::read_dir(self.verification_directory()) else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for file in files.flatten() {
            if file.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(file.path()) else {
                continue;
            };
            let Ok(journal) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let request = &journal["request"];
            let runtime = runtime_id(request);
            if crate::node_link::contract_valid("ArchiveVerificationRequest", request)
                && journal["request_sha256"] == request_digest(request)
                && journal["runtime"] == runtime
                && awake.contains(&runtime)
                && !ids.contains(&runtime)
            {
                ids.push(runtime);
            }
        }
        ids
    }

    fn cancellation_path(&self, operation: &str) -> PathBuf {
        self.verification_directory()
            .join(format!("{operation}.cancelled.json"))
    }
    /// This durable tombstone precedes the cancellation acknowledgement. It is a permanent
    /// retired-operation fence: a delayed old desired page must never recreate its scratch copy.
    pub(crate) fn record_archive_cancellation(&self, cancellation: &Value) -> io::Result<()> {
        if !crate::node_link::contract_valid("ArchiveVerificationCancellation", cancellation) {
            return Err(io::Error::other("invalid archive cancellation"));
        }
        let path = self.cancellation_path(
            cancellation["operation"]
                .as_str()
                .expect("validated operation"),
        );
        match std::fs::read(&path) {
            Ok(bytes) => {
                let held: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                if held["cancellation"] != *cancellation {
                    return Err(io::Error::other("archive cancellation conflict"));
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        create_private_directory(&self.verification_directory())?;
        write_private(&path,json!({"version":1,"cancellation":cancellation,"runtime":runtime_id(cancellation),"result":null}).to_string().as_bytes())
    }

    pub(crate) async fn cancel_archive_verification(&self, cancellation: &Value) -> Value {
        if self.record_archive_cancellation(cancellation).is_err() {
            return cancellation_result(cancellation, false, "verification_journal_conflict");
        }
        let operation = cancellation["operation"]
            .as_str()
            .expect("validated cancellation");
        let path = self.cancellation_path(operation);
        let runtime = runtime_id(cancellation);
        let journal_path = self
            .verification_directory()
            .join(format!("{operation}.json"));
        let mut tombstone: Value = match std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(held) => held,
            None => {
                return cancellation_result(
                    cancellation,
                    false,
                    "verification_journal_unavailable",
                );
            }
        };
        if tombstone["result"]["cleaned_up"] == true {
            return tombstone["result"].clone();
        }
        let cleaned = match std::fs::read(&journal_path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(journal)
                    if cancellation_binding(&journal["request"]) == *cancellation
                        && journal["runtime"] == runtime
                        && journal["request_sha256"] == request_digest(&journal["request"]) =>
                {
                    self.clean_verification(&runtime).await
                }
                _ => false,
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let volume = VolumeId::new(&runtime, 1).expect("derived runtime ID");
                self.find(&runtime).is_none()
                    && self.machine.account(&runtime).is_none()
                    && matches!(self.machine.has_volume(&volume).await, Ok(false))
                    && self
                        .machine
                        .unit(&runtime)
                        .await
                        .is_ok_and(|unit| !unit.active.awake())
                    && matches!(self.jobs.absent(&runtime).await, Ok(true))
            }
            Err(_) => false,
        };
        let result = cancellation_result(
            cancellation,
            cleaned,
            if cleaned {
                "archive_cancelled"
            } else {
                "verification_cleanup_pending"
            },
        );
        tombstone["result"] = result.clone();
        if write_private(&path, tombstone.to_string().as_bytes()).is_err() {
            return cancellation_result(cancellation, false, "verification_journal_unavailable");
        }
        result
    }

    /// A failed executor can leave its unit or volume behind. The semaphore serializes execution,
    /// not residual resources: no later operation may create a scratch instance until every
    /// preceding operation has a durable positive cleanup receipt.
    fn verification_predecessors_clear(&self, operation: &str) -> bool {
        let files = match std::fs::read_dir(self.verification_directory()) {
            Ok(files) => files,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        for file in files {
            let Ok(file) = file else {
                return false;
            };
            if file.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(file.path()) else {
                return false;
            };
            let Ok(journal) = serde_json::from_slice::<Value>(&bytes) else {
                return false;
            };
            if let Some(cancellation) = journal.get("cancellation") {
                if cancellation["operation"] != operation && journal["result"]["cleaned_up"] != true
                {
                    return false;
                }
            } else if let Some(request) = journal.get("request") {
                if request["operation"] == operation {
                    continue;
                }
                if !crate::node_link::contract_valid("ArchiveVerificationRequest", request)
                    || journal["request_sha256"] != request_digest(request)
                    || journal["runtime"] != runtime_id(request)
                    || journal["cleaned_up"] != true
                {
                    return false;
                }
            } else if !crate::node_link::contract_valid(
                "ArchiveVerificationResult",
                &journal["result"],
            ) || journal["result"]["cleaned_up"] != true
            {
                return false;
            }
        }
        true
    }

    fn local_verification_source(&self, request: &Request, db: &super::Db) -> bool {
        let view = db.view();
        view.phase == Phase::Asleep
            && view.moving.as_deref() == Some(request.operation.as_str())
            && view.entry.as_ref().is_some_and(|entry| {
                entry.generation == request.source_generation
                    && entry.storage_generation == request.source_storage_generation
                    && entry.archive_path == request.source.path
            })
            && view.state.as_ref().and_then(|state| state.record.as_ref())
                == Some(&request.source.end)
    }

    pub(crate) async fn verify_archive(
        self: &Arc<Self>,
        value: &Value,
        source_local: bool,
        cancellation: &VerificationCancellation,
    ) -> Value {
        // Service receives schema-validated pages; retain this check because the journal is also
        // a persistent input and a malformed request must never authorize scratch cleanup.
        let parsed = serde_json::from_value::<Request>(value.clone());
        let Ok(request) = parsed else {
            return Value::Null;
        };
        if !crate::node_link::contract_valid("ArchiveVerificationRequest", value) {
            return Value::Null;
        }
        if self.cancellation_path(&request.operation).exists() {
            return self
                .cancel_archive_verification(&cancellation_binding(value))
                .await;
        }
        let completed_path = self
            .verification_directory()
            .join(format!("{}.completed.json", request.operation));
        match std::fs::read(&completed_path) {
            Ok(bytes) => {
                if let Ok(completed) = serde_json::from_slice::<Value>(&bytes)
                    && completed["request_sha256"] == request_digest(value)
                    && completed["runtime"] == runtime_id(value)
                    && cancellation_binding(&completed["result"]) == cancellation_binding(value)
                    && completed["result"]["cleaned_up"] == true
                {
                    let mut held = completed["result"].clone();
                    held["observed_at"] = facts::timestamp(super::now_ms()).into();
                    return held;
                }
                return result(
                    &request,
                    &json!({"failure":"verification_journal_conflict"}),
                    false,
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {
                return result(
                    &request,
                    &json!({"failure":"verification_journal_unavailable"}),
                    false,
                );
            }
        }
        macro_rules! refuse {
            ($reason:expr) => {
                self.refuse_verification(&request, value, $reason).await
            };
        }
        if !self.verification_predecessors_clear(&request.operation) {
            return refuse!("previous_verification_cleanup_pending");
        }
        if self.fences.fenced() || self.maintenance.load(Ordering::SeqCst) {
            return refuse!("node_unavailable");
        }
        let source = self.find(&request.database_id);
        if source_local && source.is_none() {
            return refuse!("source_changed");
        }
        let _source_lock = match &source {
            Some(db) => Some(db.lock.lock().await),
            None => None,
        };
        if source_local
            && source
                .as_ref()
                .is_none_or(|db| !self.local_verification_source(&request, db))
        {
            return refuse!("source_changed");
        }
        let runtime = runtime_id(value);
        if runtime == request.database_id
            || runtime == super::check::SCRATCH
            || self.find(&runtime).is_some()
        {
            return refuse!("scratch_identity_conflict");
        }
        let directory = self.verification_directory();
        if create_private_directory(&directory).is_err() {
            return refuse!("verification_journal_unavailable");
        }
        let path = directory.join(format!("{}.json", request.operation));
        let request_hash = request_digest(value);
        let mut journal = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(journal)
                    if journal["request_sha256"] == request_hash
                        && journal["runtime"] == runtime
                        && request_identity(&journal["request"]) == request_identity(value) =>
                {
                    journal
                }
                _ => return refuse!("verification_journal_conflict"),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let volume = VolumeId::new(&runtime, 1).expect("derived runtime ID");
                if !matches!(self.machine.has_volume(&volume).await, Ok(false))
                    || self.machine.account(&runtime).is_some()
                    || self
                        .machine
                        .unit(&runtime)
                        .await
                        .map_or(true, |unit| unit.active.awake())
                    || !matches!(self.jobs.absent(&runtime).await, Ok(true))
                {
                    return refuse!("scratch_identity_conflict");
                }
                let journal = json!({"version":1,"runtime":runtime,"request":value,"request_sha256":request_hash,"receipt":null,"cleaned_up":false});
                if write_private(&path, journal.to_string().as_bytes()).is_err() {
                    return refuse!("verification_journal_unavailable");
                }
                journal
            }
            Err(_) => return refuse!("verification_journal_unavailable"),
        };
        if journal["cleaned_up"] == true {
            return result(&request, &journal["receipt"], true);
        }
        if cancellation.cancelled.load(Ordering::SeqCst) && journal["receipt"].is_null() {
            journal["receipt"] = json!({"failure":"archive_cancelled"});
            if write_private(&path, journal.to_string().as_bytes()).is_err() {
                return refuse!("verification_journal_unavailable");
            }
        }
        if journal["receipt"].is_null() {
            // A previous agent may have left PostgreSQL running on these files. Readback and stop
            // precede refetching; the valid journal is the resource ownership proof.
            if !self.clean_verification(&runtime).await {
                return result(&request, &json!({"failure":"cleanup_pending"}), false);
            }
            let checked = tokio::select! {
                checked = tokio::time::timeout(Duration::from_secs(24 * 3600), self.run_verification(&request, &runtime)) => checked,
                () = cancellation.wait() => Ok(Err("archive_cancelled")),
            };
            journal["receipt"] = match checked {
                Ok(Ok(restored)) => {
                    json!({"system_identifier":restored.system_identifier,"timeline":restored.timeline})
                }
                Ok(Err(reason)) => json!({"failure":reason}),
                Err(_) => json!({"failure":"verification_timeout"}),
            };
            // A successful recovery receipt becomes durable BEFORE deleting its scratch copy.
            if write_private(&path, journal.to_string().as_bytes()).is_err() {
                return result(
                    &request,
                    &json!({"failure":"verification_journal_unavailable"}),
                    false,
                );
            }
        }
        let cleaned = self.clean_verification(&runtime).await;
        journal["cleaned_up"] = cleaned.into();
        if write_private(&path, journal.to_string().as_bytes()).is_err() {
            return result(
                &request,
                &json!({"failure":"verification_journal_unavailable"}),
                false,
            );
        }
        if source_local
            && source
                .as_ref()
                .is_none_or(|db| !self.local_verification_source(&request, db))
        {
            return result(&request, &json!({"failure":"source_changed"}), cleaned);
        }
        result(&request, &journal["receipt"], cleaned)
    }

    async fn run_verification(
        self: &Arc<Self>,
        request: &Request,
        runtime: &str,
    ) -> Result<Restored, &'static str> {
        let source = self
            .store(&request.source.path, Access::ReadOnly)
            .ok_or("archive_unusable")?;
        let account = self
            .machine
            .ensure_account(runtime)
            .await
            .map_err(|_| "verification_account_failed")?;
        let volume = VolumeId::new(runtime, 1).map_err(|_| "verification_identity_invalid")?;
        let size = request
            .resources
            .storage_mib
            .checked_mul(1 << 20)
            .ok_or("verification_capacity_invalid")?;
        self.machine
            .create_volume(&volume, size, &account, &self.policy().storage)
            .await
            .map_err(|_| "verification_storage_unavailable")?;
        self.machine
            .prepare_socket_directory(runtime, &account)
            .map_err(|_| "verification_socket_unavailable")?;
        std::fs::set_permissions(
            self.layout().socket_directory(runtime),
            std::fs::Permissions::from_mode(0o700),
        )
        .map_err(|_| "verification_socket_unavailable")?;
        let database = job_database(
            self.layout(),
            &self.machine.device(&volume),
            &volume,
            &account.name,
        );
        let verifier = Verifier {
            table: &self.table,
            jobs: &self.jobs,
            credentials: &self.credentials,
            fetch_command: &self.layout().fetch_command,
        };
        let end = End {
            system_identifier: request.source.end.system_identifier.clone(),
            timeline: request.source.end.timeline,
            last_segment: request.source.end.last_archived_segment.clone(),
        };
        let order = verify::Order {
            database: &database,
            source: &source,
            backup_id: &request.source.backup_id,
            end: &end,
            operation: &request.operation,
            memory_mib: request.resources.memory_mib,
            max_connections: request.settings.max_connections,
            uid: account.uid,
            gid: account.gid,
        };
        let host = Scratch {
            core: self.clone(),
            runtime: runtime.to_string(),
            volume,
            account,
            request,
        };
        verifier.run(&order, &host).await
    }
}

struct Scratch<'a, M: Machine> {
    core: Arc<Core<M>>,
    runtime: String,
    volume: VolumeId,
    account: Account,
    request: &'a Request,
}
impl<M: Machine> verify::Host for Scratch<'_, M> {
    async fn start(&self) -> Result<(), Failed> {
        let machine = &self.core.machine;
        let data = self.core.layout().data(&self.runtime);
        let socket = self.core.layout().socket_directory(&self.runtime);
        let settings = settings::Settings {
            socket_directory: &socket,
            memory_mib: self.request.resources.memory_mib,
            volume_bytes: self.request.resources.storage_mib * (1 << 20),
            max_connections: self.request.settings.max_connections,
            archive_timeout_seconds: self.request.settings.archive_timeout_seconds,
            archive_command: None,
        };
        let conf = settings::postgresql_conf(&settings).ok_or(Failed)?;
        let ident = settings::pg_ident(&machine.agent_user(), &self.account.name).ok_or(Failed)?;
        for (name, content) in [
            ("postgresql.conf", conf.as_str()),
            ("postgresql.auto.conf", ""),
            (
                "pg_hba.conf",
                "local all postgres peer map=pgcf_agent\nlocal all all reject\nhost all all all reject\n",
            ),
            ("pg_ident.conf", ident.as_str()),
        ] {
            write_owned(&data, name, content, &self.account).map_err(|_| Failed)?;
        }
        let permit = self
            .core
            .admission
            .admit(AdmissionRequest {
                database: self.runtime.clone(),
                memory_mib: self.request.resources.memory_mib,
                always_warm: true,
            })
            .await
            .map_err(|_| Failed)?;
        let io = self.core.policy();
        let bind = Bind {
            volume: self.volume.clone(),
            device: machine.device(&self.volume).into(),
            data,
            account: self.account.clone(),
            properties: Limits {
                memory_mib: self.request.resources.memory_mib,
                cpu_millicores: self.request.resources.cpu_millicores,
                tasks_max: 64,
                io: Some(Io::scaled(
                    machine.device(&self.volume),
                    io.write_bytes_per_second,
                    io.write_iops,
                    self.request.resources.memory_mib,
                )),
            }
            .properties(),
        };
        let started = async {
            let bound = machine.bind(&self.runtime, &bind).await?;
            machine.exec(&bound).await
        }
        .await;
        if started.is_ok() {
            permit.ready();
            self.core.refill.notify_one();
            Ok(())
        } else {
            // Unknown/running work retains its admission until positive cleanup.
            if machine
                .unit(&self.runtime)
                .await
                .map_or(true, |unit| unit.active.awake())
            {
                permit.ready();
            } else {
                permit.failed();
            }
            Err(Failed)
        }
    }
    async fn promoted(&self) -> Result<Restored, Failed> {
        let socket = self.core.layout().socket_directory(&self.runtime);
        let session = postgres::agent(&socket).await.map_err(|_| Failed)?;
        loop {
            let rows = session
                .query("SELECT pg_catalog.pg_is_in_recovery()", &[])
                .await
                .map_err(|_| Failed)?;
            if !rows[0].try_get::<_, bool>(0).map_err(|_| Failed)? {
                break;
            }
            if let Ok(rows) = session
                .query("SELECT pg_catalog.pg_get_wal_replay_pause_state()", &[])
                .await
                && rows[0].try_get::<_, String>(0).map_err(|_| Failed)? != "not paused"
            {
                return Err(Failed);
            }
            if self
                .core
                .machine
                .unit(&self.runtime)
                .await
                .map_or(true, |unit| !unit.active.awake())
            {
                return Err(Failed);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        session.batch_long("CHECKPOINT").await.map_err(|_| Failed)?;
        let identity = sleep::system(&session).await.ok_or(Failed)?;
        Ok(Restored {
            in_recovery: false,
            system_identifier: identity.identifier,
            timeline: u32::try_from(identity.timeline).map_err(|_| Failed)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::testing::{Rig, eventually},
        link::Order,
        node_link::contract_valid,
    };

    async fn sleeping(rig: &Rig) -> (Value, Arc<super::super::Db>, Value) {
        let mut entry = rig.entry_json();
        let (parsed, db) = rig.create_from(&entry).await;
        let session = rig.agent(&parsed.id).await;
        session.batch("CREATE TABLE public.archive_witness(id integer PRIMARY KEY); INSERT INTO public.archive_witness VALUES(42)").await.unwrap();
        drop(session);
        entry.as_object_mut().unwrap().remove("origin");
        let operation = "op_zzzzzzzzzzzzzzzzzzzz";
        rig.core
            .apply(&Rig::page(
                vec![entry.clone()],
                vec![Order::Move {
                    operation: operation.into(),
                    database: parsed.id.clone(),
                    storage_generation: 1,
                }],
            ))
            .await;
        eventually(60, "source sleep", || {
            db.phase() == Phase::Asleep && rig.core.pending_order(operation).is_some()
        })
        .await;
        assert_eq!(rig.core.pending_order(operation).unwrap()["status"], "done");
        let state = db.state().unwrap();
        let request = json!({
            "operation":operation,"database_id":parsed.id,"source_node_id":"nod_aaaaaaaaaaaaaaaaaaaa",
            "source_generation":parsed.generation,"source_storage_generation":parsed.storage_generation,
            "inventory_sha256":"a".repeat(64),"source":{
                "database_id":parsed.id,"path":parsed.archive_path,
                "credential":{"id":"crd_bbbbbbbbbbbbbbbbbbbb","expires_at":"2099-01-01T00:00:00.000Z"},
                "backup_id":state.backup.unwrap().backup_id,"end":state.record.unwrap().observation(),
            },"resources":entry["resources"],"settings":entry["settings"],
        });
        assert!(contract_valid("ArchiveVerificationRequest", &request));
        rig.deliver(&parsed.archive_path, "read_only");
        (request, db, entry)
    }

    #[test]
    fn scratch_identity_is_stable_operation_bound_and_distinct_from_check() {
        let request =
            json!({"operation":"op_aaaaaaaaaaaaaaaaaaaa","database_id":"abcdefghijklmnopqrst"});
        let first = runtime_id(&request);
        assert!(VolumeId::new(&first, 1).is_ok());
        assert_ne!(first, super::super::check::SCRATCH);
        assert_eq!(first, runtime_id(&request));
        let mut next = request.clone();
        next["operation"] = json!("op_bbbbbbbbbbbbbbbbbbbb");
        assert_ne!(first, runtime_id(&next));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn scratch_verification_keeps_source_and_removes_only_its_own_resources() {
        let Some(rig) = Rig::new("cold-verify").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        let before = db.state().unwrap().record;
        let result = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(result["status"], "verified", "{result}");
        assert!(contract_valid("ArchiveVerificationResult", &result));
        assert_eq!(result["end"], request["source"]["end"]);
        assert_eq!(result["backup_id"], request["source"]["backup_id"]);
        assert_eq!(db.state().unwrap().record, before);
        assert_eq!(db.phase(), Phase::Asleep);
        let runtime = runtime_id(&request);
        assert!(rig.core.find(&runtime).is_none());
        assert!(rig.machine.account(&runtime).is_none());
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&runtime, 1).unwrap())
                .await
                .unwrap()
        );
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
        assert!(!rig.machine.running(&runtime));
        let mut refreshed = request.clone();
        refreshed["source"]["credential"]["id"] = json!("crd_cccccccccccccccccccc");
        refreshed["source"]["credential"]["expires_at"] = json!("2100-01-01T00:00:00.000Z");
        let again = rig
            .core
            .verify_archive(&refreshed, true, &VerificationCancellation::default())
            .await;
        assert_eq!(
            again["status"], "verified",
            "a persisted receipt is reused after cleanup"
        );
        assert_eq!(again["timeline"], result["timeline"]);
        rig.core.archive_verification_posted(&again);
        rig.core
            .cleanup_archive_verifications(&HashSet::new(), &HashSet::new())
            .await;
        let completed = rig.core.verification_directory().join(format!(
            "{}.completed.json",
            request["operation"].as_str().unwrap()
        ));
        assert!(completed.exists());
        rig.fixture.set("fetch-fail", "");
        // The remote-source case has no local-source guard to hide accidental reexecution.
        let late = rig
            .core
            .verify_archive(&refreshed, false, &VerificationCancellation::default())
            .await;
        assert_eq!(late["status"], "verified", "{late}");
        assert!(rig.machine.account(&runtime).is_none());
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&runtime, 1).unwrap())
                .await
                .unwrap()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelled_verification_proves_cleanup_without_touching_source() {
        let Some(rig) = Rig::new("cold-cancel").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        let cancellation = VerificationCancellation::default();
        cancellation.cancel();
        let result = rig.core.verify_archive(&request, true, &cancellation).await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "archive_cancelled");
        assert_eq!(result["cleaned_up"], true);
        assert!(contract_valid("ArchiveVerificationResult", &result));
        assert_eq!(db.phase(), Phase::Asleep);
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
        let path = rig
            .core
            .verification_directory()
            .join(format!("{}.json", request["operation"].as_str().unwrap()));
        rig.core
            .cleanup_archive_verifications(&HashSet::new(), &HashSet::new())
            .await;
        assert!(
            path.exists(),
            "task absence is not a receipt acknowledgment"
        );
        rig.core.archive_verification_posted(&result);
        rig.core
            .cleanup_archive_verifications(&HashSet::new(), &HashSet::new())
            .await;
        assert!(!path.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn changed_sleep_proof_refuses_deletion_authority_and_preserves_source() {
        let Some(rig) = Rig::new("cold-proof").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (mut request, db, _) = sleeping(&rig).await;
        request["source"]["end"]["proven_at"] = json!("2026-10-01T00:00:00.000Z");
        let result = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "source_changed");
        assert_eq!(result["cleaned_up"], true);
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rehydrate_on_the_same_node_preserves_identity_and_committed_rows_after_retirement() {
        let Some(rig) = Rig::new("cold-rehydrate").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let mut entry = rig.entry_json();
        let (parsed, db) = rig.create_from(&entry).await;
        let session = rig.agent(&parsed.id).await;
        session.batch("CREATE TABLE public.archive_witness(id integer PRIMARY KEY); INSERT INTO public.archive_witness VALUES(42)").await.unwrap();
        drop(session);
        entry.as_object_mut().unwrap().remove("origin");
        let hold = "op_hhhhhhhhhhhhhhhhhhhh";
        rig.core
            .apply(&Rig::page(
                vec![entry.clone()],
                vec![Order::Move {
                    operation: hold.into(),
                    database: parsed.id.clone(),
                    storage_generation: 1,
                }],
            ))
            .await;
        eventually(60, "sleep before retirement", || {
            db.phase() == Phase::Asleep && rig.core.pending_order(hold).is_some()
        })
        .await;
        let state = db.state().unwrap();
        let end = state.record.unwrap();
        let backup = state.backup.unwrap().backup_id;
        let retired = "op_rrrrrrrrrrrrrrrrrrrr";
        rig.core
            .apply(&Rig::page(
                vec![],
                vec![Order::Superseded {
                    operation: retired.into(),
                    database: parsed.id.clone(),
                    storage_generation: 1,
                    remove_volume: true,
                }],
            ))
            .await;
        eventually(60, "exact source retirement", || {
            rig.core.pending_order(retired).is_some()
        })
        .await;
        assert_eq!(rig.core.pending_order(retired).unwrap()["status"], "done");
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&parsed.id, 1).unwrap())
                .await
                .unwrap()
        );
        let operation = "op_nnnnnnnnnnnnnnnnnnnn";
        let path = format!("s3://pgcf-eu/eu-dev/{}/g2-{operation}", parsed.id);
        entry["generation"] = json!(parsed.generation + 1);
        entry["storage_generation"] = json!(2);
        entry["operation"] = json!(operation);
        entry["route_revision"] = json!(parsed.route_revision + 1);
        entry["archive"]["path"] = json!(path);
        entry["origin"] = json!({"kind":"rehydrate","source":{
            "database_id":parsed.id,"path":parsed.archive_path,"backup_id":backup,
            "credential":{"id":"crd_bbbbbbbbbbbbbbbbbbbb","expires_at":"2099-01-01T00:00:00.000Z"},"end":end.observation(),
        }});
        rig.deliver(&parsed.archive_path, "read_only");
        rig.deliver(&path, "read_write");
        let page = Rig::page(vec![entry.clone()], vec![]);
        rig.core.apply(&page).await;
        eventually(120, "rehydrated ready", || db.phase() == Phase::Ready).await;
        let state = db.state().unwrap();
        assert_eq!(state.storage_generation, 2);
        assert!(state.backup.unwrap().timeline > end.timeline);
        let session = rig.agent(&parsed.id).await;
        let rows = session
            .query("SELECT id FROM public.archive_witness", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i32>(0), 42);
        assert_eq!(
            sleep::system(&session).await.unwrap().identifier,
            end.system_identifier
        );
        assert!(rig.core.fences.blocks(&parsed.id, 1));
        assert!(!rig.core.fences.blocks(&parsed.id, 2));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_stops_the_barman_unit_before_acknowledging_cleanup() {
        let Some(rig) = Rig::new("cold-cancel-job").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        rig.fixture.set("restore-slow", "30");
        let cancellation = Arc::new(VerificationCancellation::default());
        let (core, input, cancel) = (rig.core.clone(), request.clone(), cancellation.clone());
        let task = tokio::spawn(async move { core.verify_archive(&input, true, &cancel).await });
        let runtime = runtime_id(&request);
        eventually(30, "scratch restore transient unit", || {
            rig.fixture
                .running_units()
                .iter()
                .any(|unit| unit.contains(&format!("restore-{runtime}-")))
        })
        .await;
        assert!(
            db.lock.try_lock().is_err(),
            "the source cannot wake during its verification"
        );
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["reason"], "archive_cancelled", "{result}");
        assert_eq!(result["cleaned_up"], true, "{result}");
        assert!(
            rig.fixture
                .running_units()
                .iter()
                .all(|unit| !unit.contains(&runtime))
        );
        assert!(db.lock.try_lock().is_ok());
        assert_eq!(db.phase(), Phase::Asleep);
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn restart_finishes_cleanup_of_a_durable_verified_receipt_without_restoring_again() {
        let Some(rig) = Rig::new("cold-cleanup").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (request, db, entry) = sleeping(&rig).await;
        let runtime = runtime_id(&request);
        let directory = rig.core.verification_directory();
        create_private_directory(&directory).unwrap();
        let path = directory.join(format!("{}.json", request["operation"].as_str().unwrap()));
        let receipt = json!({"system_identifier":request["source"]["end"]["system_identifier"],"timeline":request["source"]["end"]["timeline"].as_u64().unwrap()+1});
        let journal = json!({"version":1,"runtime":runtime,"request":request,"request_sha256":request_digest(&request),"receipt":receipt,"cleaned_up":false});
        write_private(&path, journal.to_string().as_bytes()).unwrap();
        let account = rig.machine.ensure_account(&runtime).await.unwrap();
        let volume = VolumeId::new(&runtime, 1).unwrap();
        rig.machine
            .create_volume(&volume, 1 << 30, &account, &rig.core.policy().storage)
            .await
            .unwrap();
        rig.machine.fail_volume_removals(1);
        let first = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(first["cleaned_up"], false);
        assert_ne!(first["status"], "verified");
        assert!(rig.machine.has_volume(&volume).await.unwrap());
        let source_id = db.id.clone();
        drop(db);
        drop(gateway);
        let rig = rig.restart().await;
        let _gateway = rig.connect_gateway().await;
        rig.fixture.set("fetch-fail", ""); // cleanup must not fetch/replay anything again
        rig.core
            .apply(&Rig::page(
                vec![entry],
                vec![Order::Move {
                    operation: request["operation"].as_str().unwrap().into(),
                    database: source_id.clone(),
                    storage_generation: 1,
                }],
            ))
            .await;
        eventually(30, "source adopted after restart", || {
            rig.core
                .find(&source_id)
                .is_some_and(|db| db.phase() == Phase::Asleep && db.view().moving.is_some())
        })
        .await;
        let done = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(done["status"], "verified", "{done}");
        assert_eq!(done["timeline"], receipt["timeline"]);
        assert!(contract_valid("ArchiveVerificationResult", &done));
        assert!(!rig.machine.has_volume(&volume).await.unwrap());
        assert!(rig.machine.account(&runtime).is_none());
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&source_id, 1).unwrap())
                .await
                .unwrap()
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_before_first_delivery_is_durable_and_blocks_a_late_request_after_restart()
    {
        let Some(rig) = Rig::new("cold-cancel-unseen").await else {
            return;
        };
        let request = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let cancellation = cancellation_binding(&request);
        assert!(contract_valid(
            "ArchiveVerificationCancellation",
            &cancellation
        ));
        let first = rig.core.cancel_archive_verification(&cancellation).await;
        assert_eq!(first["cleaned_up"], true, "{first}");
        assert_eq!(first["reason"], "archive_cancelled");
        assert!(contract_valid("ArchiveVerificationResult", &first));
        rig.core.archive_verification_posted(&first);
        let rig = rig.restart().await;
        let late = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(late["cleaned_up"], true);
        assert_eq!(late["reason"], "archive_cancelled");
        assert!(rig.machine.account(&runtime_id(&request)).is_none());
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&runtime_id(&request), 1).unwrap())
                .await
                .unwrap()
        );
        assert!(
            rig.core
                .cancellation_path(request["operation"].as_str().unwrap())
                .exists(),
            "acknowledgment does not remove the retired-operation fence"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_unseen_cancellation_cannot_claim_cleanup_when_runtime_readback_is_unknown() {
        let Some(rig) = Rig::new("cold-cancel-unknown").await else {
            return;
        };
        let request = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let cancellation = cancellation_binding(&request);
        rig.machine.set_units_unreadable(true);
        let unknown = rig.core.cancel_archive_verification(&cancellation).await;
        assert_eq!(unknown["cleaned_up"], false);
        rig.machine.set_units_unreadable(false);
        // A job that left its private payload directory is also unproven residual work. A
        // cancellation with no ownership journal must not adopt or delete it.
        let residue = rig
            .fixture
            .jobs_directory()
            .join(format!("pgcf-job-restore-{}-123", runtime_id(&request)));
        std::fs::create_dir(&residue).unwrap();
        let unknown = rig.core.cancel_archive_verification(&cancellation).await;
        assert_eq!(unknown["cleaned_up"], false);
        assert!(residue.exists());
        std::fs::remove_dir(&residue).unwrap();
        let known = rig.core.cancel_archive_verification(&cancellation).await;
        assert_eq!(known["cleaned_up"], true);
        assert_eq!(known["reason"], "archive_cancelled");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn failed_predecessor_cleanup_blocks_a_new_scratch_runtime() {
        let Some(rig) = Rig::new("cold-one-runtime").await else {
            return;
        };
        let old = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let runtime = runtime_id(&old);
        let directory = rig.core.verification_directory();
        create_private_directory(&directory).unwrap();
        let old_path = directory.join(format!("{}.json", old["operation"].as_str().unwrap()));
        write_private(&old_path,json!({"version":1,"runtime":runtime,"request":old,"request_sha256":request_digest(&old),"receipt":{"failure":"verification_interrupted"},"cleaned_up":false}).to_string().as_bytes()).unwrap();
        let account = rig.machine.ensure_account(&runtime).await.unwrap();
        let volume = VolumeId::new(&runtime, 1).unwrap();
        rig.machine
            .create_volume(&volume, 1 << 30, &account, &rig.core.policy().storage)
            .await
            .unwrap();
        rig.machine.fail_volume_removals(1);
        rig.core
            .cleanup_archive_verifications(&HashSet::new(), &HashSet::new())
            .await;
        assert!(rig.machine.has_volume(&volume).await.unwrap());
        let mut next = old.clone();
        next["operation"] = json!("op_yyyyyyyyyyyyyyyyyyyy");
        let result = rig
            .core
            .verify_archive(&next, false, &VerificationCancellation::default())
            .await;
        assert_eq!(result["status"], "failed");
        assert_eq!(
            result["reason"], "previous_verification_cleanup_pending",
            "{result}"
        );
        assert!(rig.machine.account(&runtime_id(&next)).is_none());
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&runtime_id(&next), 1).unwrap())
                .await
                .unwrap()
        );
        assert!(rig.machine.has_volume(&volume).await.unwrap());
    }
}
