// SPDX-License-Identifier: Apache-2.0
//! Isolated, operation-owned archive verification. These instances never enter the gateway's
//! database table, carry a tenant route, dispatch events or write the source archive. A durable
//! journal precedes creating resources; a successful receipt precedes their removal. The original
//! database's volume is never removed here: only Cloudflare's later superseded order may do that.
use super::{Core, Phase, build::write_owned};
use crate::{
    admission::Request as AdmissionRequest,
    archive::{cold_snapshot, facts, recovery::Restored, restore::Failed},
    link::file::{create_private_directory, sync_directory, write_private},
    machine::{Account, Machine},
    postgres, proof, settings, sleep,
    state::{ProvenSleepRecord, Resources},
    storage::{Removal, VolumeId},
    units::{
        limits::{Io, Limits},
        slots::Bind,
    },
};
use serde::{Deserialize, Serialize};
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
    pub(crate) async fn wait(&self) {
        if !self.cancelled.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }
}

/// A complete clean-shutdown snapshot of this database's prior storage generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColdSnapshotSource {
    pub database_id: String,
    pub snapshot_operation: String,
    pub source_generation: u64,
    pub source_storage_generation: u64,
    pub manifest_sha256: String,
    pub manifest_bytes: u64,
    pub end: ProvenSleepRecord,
}
impl ColdSnapshotSource {
    pub(crate) fn received(value: &Value) -> Result<Self, serde_json::Error> {
        let names = [
            "database_id",
            "snapshot_operation",
            "source_generation",
            "source_storage_generation",
            "manifest_sha256",
            "manifest_bytes",
            "end",
        ];
        let mut fields = serde_json::Map::new();
        for name in names {
            if let Some(value) = value.get(name) {
                fields.insert(name.to_string(), value.clone());
            }
        }
        serde_json::from_value(Value::Object(fields))
    }
    pub(crate) fn binding(&self) -> cold_snapshot::Binding {
        cold_snapshot::Binding {
            operation: self.snapshot_operation.clone(),
            database_id: self.database_id.clone(),
            source_generation: self.source_generation,
            source_storage_generation: self.source_storage_generation,
            end: self.end.clone(),
        }
    }
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
    source: ColdSnapshotSource,
    resources: Resources,
    settings: Settings,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn request_digest(value: &Value) -> String {
    digest(value.to_string().as_bytes())
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
        "observed_at": facts::timestamp(super::now_ms()), "cleaned_up": cleaned_up,
    });
    if cleaned_up && receipt.get("system_identifier").is_some() {
        result["status"] = json!("verified");
        result["system_identifier"] = receipt["system_identifier"].clone();
        result["timeline"] = receipt["timeline"].clone();
        result["manifest_sha256"] = json!(request.source.manifest_sha256);
        result["checkpoint_lsn"] = receipt["checkpoint_lsn"].clone();
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

const CANCELLATION_FIELDS: [&str; 4] = [
    "operation",
    "database_id",
    "source_generation",
    "source_storage_generation",
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
                    if journal["request"] == *value
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
        let mut input = value.clone();
        if let Ok(source) = ColdSnapshotSource::received(&value["source"]) {
            input["source"] = serde_json::to_value(source).expect("snapshot source serializes");
        }
        let parsed = serde_json::from_value::<Request>(input);
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
                        && journal["request"] == *value =>
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
                    json!({"system_identifier":restored.system_identifier,"timeline":restored.timeline,"checkpoint_lsn":request.source.end.checkpoint_lsn})
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
        let transport = self.cold_snapshot_transport(&request.source.snapshot_operation)?;
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
        let data = self.layout().data(runtime);
        let slot = self
            .jobs
            .snapshot_slot()
            .await
            .map_err(|_| "snapshot_busy")?;
        let manifest = cold_snapshot::restore_and_verify(
            &data,
            &request.source.binding(),
            &request.source.manifest_sha256,
            &*transport,
            Some((account.uid, account.gid)),
        )
        .await?;
        cold_snapshot::verify_data(&data, &manifest).await?;
        drop(slot);
        if manifest.encode()?.len() as u64 != request.source.manifest_bytes {
            return Err("snapshot_manifest_mismatch");
        }
        proof::wake_check(Some(&request.source.end), &self.layout().volume(runtime))
            .map_err(|_| "snapshot_control_mismatch")?;
        let host = Scratch {
            core: self.clone(),
            runtime: runtime.into(),
            volume,
            account,
            request,
        };
        host.start()
            .await
            .map_err(|_| "verification_start_failed")?;
        let started = host
            .started_identity()
            .await
            .map_err(|_| "verification_start_failed")?;
        if started.in_recovery
            || started.system_identifier != request.source.end.system_identifier
            || started.timeline != request.source.end.timeline
        {
            return Err("snapshot_identity_mismatch");
        }
        Ok(started)
    }
}

struct Scratch<'a, M: Machine> {
    core: Arc<Core<M>>,
    runtime: String,
    volume: VolumeId,
    account: Account,
    request: &'a Request,
}
impl<M: Machine> Scratch<'_, M> {
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
        let mut conf = settings::postgresql_conf(&settings).ok_or(Failed)?;
        conf.push_str("\narchive_mode = off\nshared_preload_libraries = ''\nlocal_preload_libraries = ''\nsession_preload_libraries = ''\nlisten_addresses = ''\nautovacuum = off\n");
        let ident = settings::pg_ident(&machine.agent_user(), &self.account.name).ok_or(Failed)?;
        for (name, content) in [
            ("postgresql.conf", conf.as_str()),
            ("postgresql.auto.conf", ""),
            ("pgcf-recovery.conf", ""),
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
    async fn started_identity(&self) -> Result<Restored, Failed> {
        let socket = self.core.layout().socket_directory(&self.runtime);
        let session = postgres::agent(&socket).await.map_err(|_| Failed)?;
        let rows = session
            .query("SELECT pg_catalog.pg_is_in_recovery()", &[])
            .await
            .map_err(|_| Failed)?;
        if rows[0].try_get::<_, bool>(0).map_err(|_| Failed)? {
            return Err(Failed);
        }
        let identity = sleep::system(&session).await.ok_or(Failed)?;
        Ok(Restored {
            in_recovery: false,
            system_identifier: identity.identifier,
            timeline: u32::try_from(identity.timeline).map_err(|_| Failed)?,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        agent::testing::{Rig, eventually},
        link::Order,
        node_link::contract_valid,
        settings::AGENT_ROLE,
    };

    async fn source(rig: &Rig) -> (Value, Arc<super::super::Db>, Value) {
        source_from(rig, rig.entry_json()).await
    }
    async fn source_from(rig: &Rig, mut entry: Value) -> (Value, Arc<super::super::Db>, Value) {
        let (parsed, db) = rig.create_from(&entry).await;
        let session = postgres::connect(
            &rig.machine.layout().socket_directory(&parsed.id),
            AGENT_ROLE,
            &parsed.id,
        )
        .await
        .unwrap();
        session.batch("CREATE TABLE snapshot_logged(id integer PRIMARY KEY); INSERT INTO snapshot_logged VALUES(41); CREATE UNLOGGED TABLE snapshot_unlogged(id integer PRIMARY KEY); INSERT INTO snapshot_unlogged VALUES(42)").await.unwrap();
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
        eventually(60, "source clean sleep", || {
            db.phase() == Phase::Asleep && rig.core.pending_order(operation).is_some()
        })
        .await;
        assert_eq!(rig.core.pending_order(operation).unwrap()["status"], "done");
        let capture = json!({"operation":operation,"database_id":parsed.id,"source_node_id":"nod_aaaaaaaaaaaaaaaaaaaa","source_generation":parsed.generation,"source_storage_generation":1,"end":db.state().unwrap().record.unwrap().observation()});
        assert!(contract_valid("ColdSnapshotCaptureRequest", &capture));
        (capture, db, entry)
    }
    pub(crate) async fn sleeping(rig: &Rig) -> (Value, Arc<super::super::Db>, Value) {
        let (capture, db, entry) = source(rig).await;
        let request = captured_request(rig, &capture, &entry).await;
        (request, db, entry)
    }
    async fn captured_request(rig: &Rig, capture: &Value, entry: &Value) -> Value {
        let captured = rig
            .core
            .capture_cold_snapshot(
                capture,
                "nod_aaaaaaaaaaaaaaaaaaaa",
                &VerificationCancellation::default(),
            )
            .await;
        assert_eq!(captured["status"], "captured", "{captured}");
        assert!(contract_valid("ColdSnapshotCaptureResult", &captured));
        let request = json!({"operation":capture["operation"],"database_id":capture["database_id"],"source_node_id":capture["source_node_id"],"source_generation":capture["source_generation"],"source_storage_generation":capture["source_storage_generation"],"source":{
            "database_id":capture["database_id"],"snapshot_operation":capture["operation"],"source_generation":capture["source_generation"],"source_storage_generation":capture["source_storage_generation"],"manifest_sha256":captured["manifest_sha256"],"manifest_bytes":captured["manifest_bytes"],"end":capture["end"]
        },"resources":entry["resources"],"settings":entry["settings"]});
        assert!(contract_valid("ArchiveVerificationRequest", &request));
        request
    }
    #[test]
    fn scratch_identity_is_operation_bound_and_distinct_from_health_check() {
        let request =
            json!({"operation":"op_aaaaaaaaaaaaaaaaaaaa","database_id":"abcdefghijklmnopqrst"});
        let id = runtime_id(&request);
        assert!(VolumeId::new(&id, 1).is_ok());
        assert_ne!(id, super::super::check::SCRATCH);
        let mut other = request.clone();
        other["operation"] = json!("op_bbbbbbbbbbbbbbbbbbbb");
        assert_ne!(id, runtime_id(&other));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn complete_snapshot_verification_keeps_source_and_retires_its_completed_operation() {
        let Some(rig) = Rig::new("cold-complete").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        let before = db.state().unwrap().record;
        let operation = request["operation"].as_str().unwrap();
        let writes = rig.cold_store.writes(operation);
        let result = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(result["status"], "verified", "{result}");
        assert!(contract_valid("ArchiveVerificationResult", &result));
        assert_eq!(result["timeline"], request["source"]["end"]["timeline"]);
        assert_eq!(
            result["checkpoint_lsn"],
            request["source"]["end"]["checkpoint_lsn"]
        );
        assert_eq!(
            result["manifest_sha256"],
            request["source"]["manifest_sha256"]
        );
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
        assert_eq!(
            rig.cold_store.writes(operation),
            writes,
            "verification never uploads a snapshot or backup"
        );
        rig.core.archive_verification_posted(&result);
        rig.core
            .cleanup_archive_verifications(&HashSet::new(), &HashSet::new())
            .await;
        assert!(
            rig.core
                .verification_directory()
                .join(format!("{operation}.completed.json"))
                .exists()
        );
        rig.cold_store.remove_chunk(operation, 0);
        let late = rig
            .core
            .verify_archive(&request, false, &VerificationCancellation::default())
            .await;
        assert_eq!(
            late["status"], "verified",
            "late old page returns its completed receipt without another download"
        );
        assert!(rig.machine.account(&runtime).is_none());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_missing_snapshot_chunk_never_starts_postgres_or_releases_the_source() {
        let Some(rig) = Rig::new("cold-missing").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        let runtime = runtime_id(&request);
        rig.cold_store
            .remove_chunk(request["operation"].as_str().unwrap(), 0);
        let result = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["cleaned_up"], true);
        assert!(
            !rig.machine
                .calls()
                .iter()
                .any(|call| call == &format!("start {runtime}"))
        );
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
        assert_eq!(db.phase(), Phase::Asleep);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_drains_the_download_before_acknowledging_cleanup() {
        let Some(rig) = Rig::new("cold-cancel-download").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (request, db, _) = sleeping(&rig).await;
        rig.cold_store.block_reads();
        let reads = rig.cold_store.reads();
        let cancellation = Arc::new(VerificationCancellation::default());
        let (core, input, cancel) = (rig.core.clone(), request.clone(), cancellation.clone());
        let task = tokio::spawn(async move { core.verify_archive(&input, true, &cancel).await });
        eventually(30, "snapshot download", || rig.cold_store.reads() > reads).await;
        assert!(db.lock.try_lock().is_err());
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(30), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["reason"], "archive_cancelled", "{result}");
        assert_eq!(result["cleaned_up"], true);
        rig.cold_store.release_reads();
        let runtime = runtime_id(&request);
        assert!(db.lock.try_lock().is_ok());
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
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn restart_finishes_verified_cleanup_without_refetching_the_snapshot() {
        let Some(rig) = Rig::new("cold-cleanup").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (request, db, entry) = sleeping(&rig).await;
        let runtime = runtime_id(&request);
        let directory = rig.core.verification_directory();
        create_private_directory(&directory).unwrap();
        let path = directory.join(format!("{}.json", request["operation"].as_str().unwrap()));
        let receipt = json!({"system_identifier":request["source"]["end"]["system_identifier"],"timeline":request["source"]["end"]["timeline"],"checkpoint_lsn":request["source"]["end"]["checkpoint_lsn"]});
        write_private(&path,json!({"version":1,"runtime":runtime,"request":request,"request_sha256":request_digest(&request),"receipt":receipt,"cleaned_up":false}).to_string().as_bytes()).unwrap();
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
        let source_id = db.id.clone();
        drop(db);
        drop(gateway);
        let rig = rig.restart().await;
        let _gateway = rig.connect_gateway().await;
        rig.cold_store
            .remove_chunk(request["operation"].as_str().unwrap(), 0);
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
        eventually(30, "source readopted", || {
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
        assert!(!rig.machine.has_volume(&volume).await.unwrap());
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&source_id, 1).unwrap())
                .await
                .unwrap()
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unseen_cancellation_is_durable_and_rejects_late_work_after_restart() {
        let Some(rig) = Rig::new("cold-unseen").await else {
            return;
        };
        let request = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let cancellation = cancellation_binding(&request);
        let answer = rig.core.cancel_archive_verification(&cancellation).await;
        assert_eq!(answer["cleaned_up"], true);
        rig.core.archive_verification_posted(&answer);
        let rig = rig.restart().await;
        let late = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(late["reason"], "archive_cancelled");
        assert_eq!(late["cleaned_up"], true);
        assert!(rig.machine.account(&runtime_id(&request)).is_none());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unknown_or_unowned_residue_cannot_be_claimed_clean() {
        let Some(rig) = Rig::new("cold-unknown").await else {
            return;
        };
        let request = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let cancellation = cancellation_binding(&request);
        rig.machine.set_units_unreadable(true);
        assert_eq!(
            rig.core.cancel_archive_verification(&cancellation).await["cleaned_up"],
            false
        );
        rig.machine.set_units_unreadable(false);
        let residue = rig
            .fixture
            .jobs_directory()
            .join(format!("pgcf-job-restore-{}-123", runtime_id(&request)));
        std::fs::create_dir(&residue).unwrap();
        assert_eq!(
            rig.core.cancel_archive_verification(&cancellation).await["cleaned_up"],
            false
        );
        assert!(residue.exists());
        std::fs::remove_dir(residue).unwrap();
        assert_eq!(
            rig.core.cancel_archive_verification(&cancellation).await["cleaned_up"],
            true
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unfinished_predecessor_blocks_a_second_scratch_runtime() {
        let Some(rig) = Rig::new("cold-predecessor").await else {
            return;
        };
        let old = crate::link::test_server::vector(
            "ArchiveVerificationRequest",
            "isolated-archive-verification",
        );
        let runtime = runtime_id(&old);
        let directory = rig.core.verification_directory();
        create_private_directory(&directory).unwrap();
        write_private(&directory.join(format!("{}.json",old["operation"].as_str().unwrap())),json!({"version":1,"request":old,"request_sha256":request_digest(&old),"runtime":runtime,"receipt":{"failure":"verification_interrupted"},"cleaned_up":false}).to_string().as_bytes()).unwrap();
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
        let mut next = old.clone();
        next["operation"] = json!("op_yyyyyyyyyyyyyyyyyyyy");
        next["source"]["snapshot_operation"] = next["operation"].clone();
        let answer = rig
            .core
            .verify_archive(&next, false, &VerificationCancellation::default())
            .await;
        assert_eq!(answer["reason"], "previous_verification_cleanup_pending");
        assert!(rig.machine.account(&runtime_id(&next)).is_none());
        assert!(rig.machine.has_volume(&volume).await.unwrap());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn same_node_rehydrate_preserves_logged_and_unlogged_rows_and_cluster_identity() {
        let Some(rig) = Rig::new("cold-unlogged-roundtrip").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (request, db, mut entry) = sleeping(&rig).await;
        let verified = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(verified["status"], "verified", "{verified}");
        let id = db.id.clone();
        let retired = "op_rrrrrrrrrrrrrrrrrrrr";
        rig.core
            .apply(&Rig::page(
                vec![],
                vec![Order::Superseded {
                    operation: retired.into(),
                    database: id.clone(),
                    storage_generation: 1,
                    remove_volume: true,
                }],
            ))
            .await;
        eventually(30, "source retirement", || {
            rig.core.pending_order(retired).is_some()
        })
        .await;
        assert!(
            !rig.machine
                .has_volume(&VolumeId::new(&id, 1).unwrap())
                .await
                .unwrap()
        );
        let operation = "op_nnnnnnnnnnnnnnnnnnnn";
        let path = format!("s3://pgcf-eu/eu-dev/{id}/g2-{operation}");
        entry["generation"] = json!(entry["generation"].as_u64().unwrap() + 1);
        entry["storage_generation"] = json!(2);
        entry["operation"] = json!(operation);
        entry["route_revision"] = json!(entry["route_revision"].as_u64().unwrap() + 1);
        entry["archive"]["path"] = json!(path);
        entry["origin"] = json!({"kind":"rehydrate","source":request["source"]});
        entry["cold_snapshot_pending"] = true.into();
        rig.deliver(&path, "read_write");
        rig.core
            .apply(&Rig::page(vec![entry.clone()], vec![]))
            .await;
        eventually(120, "clean physical rehydrate", || {
            matches!(db.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(db.phase(), Phase::Ready, "{:?}", db.view().error);
        let state = db.state().unwrap();
        assert_eq!(state.storage_generation, 2);
        let session =
            postgres::connect(&rig.machine.layout().socket_directory(&id), AGENT_ROLE, &id)
                .await
                .unwrap();
        assert_eq!(
            session
                .query("SELECT id FROM snapshot_logged", &[])
                .await
                .unwrap()[0]
                .get::<_, i32>(0),
            41
        );
        assert_eq!(
            session
                .query("SELECT id FROM snapshot_unlogged", &[])
                .await
                .unwrap()[0]
                .get::<_, i32>(0),
            42
        );
        assert_eq!(
            sleep::system(&session).await.unwrap().identifier,
            request["source"]["end"]["system_identifier"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            state.backup.unwrap().timeline,
            request["source"]["end"]["timeline"].as_u64().unwrap() as u32
        );
        let proof = state
            .cold_snapshot_restore
            .expect("ready carries the verified whole-file attestation");
        assert_eq!(
            proof.manifest_sha256,
            request["source"]["manifest_sha256"].as_str().unwrap()
        );
        let stage = rig.observed(&id, "ready").await;
        assert_eq!(stage["cold_snapshot_serving"], false);
        assert_eq!(
            crate::agent::table_entry(&id, &db.view()).unwrap().mode,
            pgcf_native_protocol::agent::Mode::Sleeping
        );
        drop(session);
        let mut activation = entry.clone();
        activation.as_object_mut().unwrap().remove("origin");
        activation["generation"] = json!(entry["generation"].as_u64().unwrap() + 1);
        activation["route_revision"] = json!(entry["route_revision"].as_u64().unwrap() + 1);
        rig.core
            .apply(&Rig::page(vec![activation.clone()], vec![]))
            .await;
        eventually(30, "activation Ready receipt", || {
            rig.core.pending_observation(&id).is_some_and(|value| {
                value["state"] == "ready"
                    && value["generation"] == activation["generation"]
                    && value["cold_snapshot_serving"] == true
            })
        })
        .await;
        assert!(db.state().unwrap().cold_snapshot_serving);
        activation["cold_snapshot_pending"] = false.into();
        rig.core
            .apply(&Rig::page(vec![activation.clone()], vec![]))
            .await;
        eventually(30, "controller completion latched", || {
            db.state().unwrap().cold_snapshot_committed
        })
        .await;
        let session =
            postgres::connect(&rig.machine.layout().socket_directory(&id), AGENT_ROLE, &id)
                .await
                .unwrap();
        session
            .batch(
                "INSERT INTO snapshot_logged VALUES(43); INSERT INTO snapshot_unlogged VALUES(44)",
            )
            .await
            .unwrap();
        drop(session);
        let reads = rig.cold_store.reads();
        rig.cold_store
            .remove_chunk(request["operation"].as_str().unwrap(), 0);
        drop(db);
        drop(gateway);
        let rig = rig.restart().await;
        let _gateway = rig.connect_gateway().await;
        rig.deliver(&path, "read_write");
        rig.core
            .apply(&Rig::page(vec![activation.clone()], vec![]))
            .await;
        let db = rig.core.find(&id).unwrap();
        eventually(30, "committed target readopted", || {
            db.phase() == Phase::Ready
        })
        .await;
        assert!(db.state().unwrap().cold_snapshot_committed);
        let mut old_activation = activation.clone();
        old_activation["cold_snapshot_pending"] = true.into();
        rig.core
            .apply(&Rig::page(vec![old_activation], vec![]))
            .await;
        rig.core.apply(&Rig::page(vec![entry], vec![])).await;
        assert_eq!(
            rig.cold_store.reads(),
            reads,
            "committed data cannot be replaced by the stale snapshot"
        );
        let session =
            postgres::connect(&rig.machine.layout().socket_directory(&id), AGENT_ROLE, &id)
                .await
                .unwrap();
        assert_eq!(
            session
                .query("SELECT count(*)::int4 FROM snapshot_logged", &[])
                .await
                .unwrap()[0]
                .get::<_, i32>(0),
            2
        );
        assert_eq!(
            session
                .query("SELECT count(*)::int4 FROM snapshot_unlogged", &[])
                .await
                .unwrap()[0]
                .get::<_, i32>(0),
            2
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn source_capture_waits_for_the_background_budget_and_cancels_without_uploading() {
        let Some(rig) = Rig::new("cold-capture-budget").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (capture, db, _) = source(&rig).await;
        let slot = rig.core.jobs.snapshot_slot().await.unwrap();
        let cancel = Arc::new(VerificationCancellation::default());
        let (core, input, cancellation) = (rig.core.clone(), capture.clone(), cancel.clone());
        let task = tokio::spawn(async move {
            core.capture_cold_snapshot(&input, "nod_aaaaaaaaaaaaaaaaaaaa", &cancellation)
                .await
        });
        eventually(
            10,
            "capture holds the source while waiting for its slot",
            || db.lock.try_lock().is_err(),
        )
        .await;
        assert_eq!(
            rig.cold_store
                .writes(capture["operation"].as_str().unwrap()),
            0
        );
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
        drop(slot);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["reason"], "snapshot_capture_cancelled");
        assert_eq!(result["cleaned_up"], true);
        assert!(db.lock.try_lock().is_ok());
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn capture_cancellation_before_first_delivery_blocks_the_late_producer() {
        let Some(rig) = Rig::new("cold-capture-unseen").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (capture, db, _) = source(&rig).await;
        let cancelled = rig
            .core
            .cancel_cold_snapshot_capture(&cancellation_binding(&capture));
        assert_eq!(cancelled["cleaned_up"], true);
        assert!(contract_valid("ColdSnapshotCaptureResult", &cancelled));
        let late = rig
            .core
            .capture_cold_snapshot(
                &capture,
                "nod_aaaaaaaaaaaaaaaaaaaa",
                &VerificationCancellation::default(),
            )
            .await;
        assert_eq!(late["reason"], "snapshot_capture_cancelled");
        assert_eq!(
            rig.cold_store
                .writes(capture["operation"].as_str().unwrap()),
            0
        );
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_later_timeline_snapshot_rearchives_history_into_the_new_backup_prefix() {
        use crate::agent::power::{Slept, Why};
        let Some(rig) = Rig::new("cold-history").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (base, base_db) = rig.create().await;
        assert_eq!(rig.core.sleep(&base_db, Why::Idle).await, Slept::Proven);
        let backup = base_db.state().unwrap().backup.unwrap();
        rig.deliver(&base.archive_path, "read_only");
        let mut later = rig.entry_json();
        later["origin"] = json!({"kind":"restore","source":{
            "database_id":base.id,"path":base.archive_path,"backup_id":backup.backup_id,
            "credential":{"id":"crd_bbbbbbbbbbbbbbbbbbbb","expires_at":"2099-01-01T00:00:00.000Z"}
        }});
        let (capture, db, mut entry) = source_from(&rig, later).await;
        let timeline = capture["end"]["timeline"].as_u64().unwrap() as u32;
        assert!(timeline > 1);
        let history = format!("{timeline:08X}.history");
        let expected_history = std::fs::read(
            rig.machine
                .layout()
                .data(&db.id)
                .join("pg_wal")
                .join(&history),
        )
        .unwrap();
        let request = captured_request(&rig, &capture, &entry).await;
        let verified = rig
            .core
            .verify_archive(&request, true, &VerificationCancellation::default())
            .await;
        assert_eq!(verified["status"], "verified", "{verified}");
        let id = db.id.clone();
        let retired = "op_rrrrrrrrrrrrrrrrrrrr";
        rig.core
            .apply(&Rig::page(
                vec![],
                vec![Order::Superseded {
                    operation: retired.into(),
                    database: id.clone(),
                    storage_generation: 1,
                    remove_volume: true,
                }],
            ))
            .await;
        eventually(30, "timeline source retired", || {
            rig.core.pending_order(retired).is_some()
        })
        .await;
        let operation = "op_nnnnnnnnnnnnnnnnnnnn";
        let path = format!("s3://pgcf-eu/eu-dev/{id}/g2-{operation}");
        entry["generation"] = json!(entry["generation"].as_u64().unwrap() + 1);
        entry["storage_generation"] = json!(2);
        entry["operation"] = json!(operation);
        entry["route_revision"] = json!(entry["route_revision"].as_u64().unwrap() + 1);
        entry["archive"]["path"] = json!(path);
        entry["origin"] = json!({"kind":"rehydrate","source":request["source"]});
        entry["cold_snapshot_pending"] = true.into();
        rig.deliver(&path, "read_write");
        rig.core.apply(&Rig::page(vec![entry], vec![])).await;
        eventually(120, "timeline snapshot ready", || {
            matches!(db.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(db.phase(), Phase::Ready, "{:?}", db.view().error);
        let object = rig.fixture.object(&path, &history);
        assert!(
            object.exists(),
            "the new prefix must contain its current timeline history"
        );
        let recovered = std::process::Command::new("gzip")
            .arg("-dc")
            .arg(object)
            .output()
            .unwrap();
        assert!(recovered.status.success());
        assert_eq!(recovered.stdout, expected_history);
        assert_eq!(db.state().unwrap().backup.unwrap().timeline, timeline);
        let session =
            postgres::connect(&rig.machine.layout().socket_directory(&id), AGENT_ROLE, &id)
                .await
                .unwrap();
        assert_eq!(
            session
                .query("SELECT id FROM snapshot_unlogged", &[])
                .await
                .unwrap()[0]
                .get::<_, i32>(0),
            42
        );
    }
}
