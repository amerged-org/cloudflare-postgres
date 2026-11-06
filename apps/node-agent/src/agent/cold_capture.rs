// SPDX-License-Identifier: Apache-2.0
//! The source of a cold snapshot remains stopped, fenced and locally intact throughout capture.
//! A complete manifest is declared before chunks, and the immutable snapshot is sealed only after
//! every byte and the source's clean control record were rechecked. Only the later verification
//! and explicit retirement can free the original volume.
use super::{Core, Phase, VerificationCancellation};
use crate::{
    archive::{cold_snapshot, facts},
    link::file::{create_private_directory, write_private},
    machine::Machine,
    proof,
    state::ProvenSleepRecord,
    storage::VolumeId,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io,
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};

#[derive(Deserialize)]
struct Request {
    operation: String,
    database_id: String,
    source_node_id: String,
    source_generation: u64,
    source_storage_generation: u64,
    end: ProvenSleepRecord,
}
impl Request {
    fn binding(&self) -> cold_snapshot::Binding {
        cold_snapshot::Binding {
            operation: self.operation.clone(),
            database_id: self.database_id.clone(),
            source_generation: self.source_generation,
            source_storage_generation: self.source_storage_generation,
            end: self.end.clone(),
        }
    }
}
const FIELDS: [&str; 4] = [
    "operation",
    "database_id",
    "source_generation",
    "source_storage_generation",
];
fn identity(value: &Value) -> Value {
    Value::Object(
        FIELDS
            .into_iter()
            .map(|key| (key.to_string(), value[key].clone()))
            .collect(),
    )
}
fn digest(value: &Value) -> String {
    Sha256::digest(value.to_string().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn failed(request: &Value, reason: &str, cleaned: bool) -> Value {
    let mut result = identity(request);
    result["observed_at"] = facts::timestamp(super::now_ms()).into();
    result["status"] = json!("failed");
    result["reason"] = reason.into();
    result["cleaned_up"] = cleaned.into();
    result
}
impl<M: Machine> Core<M> {
    fn captures_directory(&self) -> PathBuf {
        self.layout().agent().join("cold-snapshot-captures")
    }
    fn capture_cancel_path(&self, operation: &str) -> PathBuf {
        self.captures_directory()
            .join(format!("{operation}.cancelled.json"))
    }
    pub(crate) fn record_cold_capture_cancellation(&self, value: &Value) -> io::Result<()> {
        if !crate::node_link::contract_valid("ArchiveVerificationCancellation", value) {
            return Err(io::Error::other("invalid capture cancellation"));
        }
        let path =
            self.capture_cancel_path(value["operation"].as_str().expect("validated operation"));
        match std::fs::read(&path) {
            Ok(bytes) => {
                let held: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                return if held["cancellation"] == *value {
                    Ok(())
                } else {
                    Err(io::Error::other("capture cancellation conflict"))
                };
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        create_private_directory(&self.captures_directory())?;
        write_private(
            &path,
            json!({"cancellation":value,"result":null,"acknowledged":false})
                .to_string()
                .as_bytes(),
        )
    }
    /// Called only under the service's capture/verification semaphore, after a running upload
    /// future has ended. The tombstone keeps a delayed desired page from starting another upload.
    pub(crate) fn cancel_cold_snapshot_capture(&self, value: &Value) -> Value {
        if self.record_cold_capture_cancellation(value).is_err() {
            return failed(value, "snapshot_journal_unavailable", false);
        }
        let result = failed(value, "snapshot_capture_cancelled", true);
        let path =
            self.capture_cancel_path(value["operation"].as_str().expect("validated operation"));
        let record = json!({"cancellation":value,"result":result,"acknowledged":false});
        if write_private(&path, record.to_string().as_bytes()).is_err() {
            return failed(value, "snapshot_journal_unavailable", false);
        }
        result
    }
    fn capture_source_matches(&self, request: &Request, db: &super::Db) -> bool {
        let view = db.view();
        view.phase == Phase::Asleep
            && view.moving.as_deref() == Some(request.operation.as_str())
            && view.entry.as_ref().is_some_and(|entry| {
                entry.generation == request.source_generation
                    && entry.storage_generation == request.source_storage_generation
            })
            && view.state.as_ref().and_then(|state| state.record.as_ref()) == Some(&request.end)
    }
    pub(crate) async fn capture_cold_snapshot(
        self: &Arc<Self>,
        value: &Value,
        node_id: &str,
        cancel: &VerificationCancellation,
    ) -> Value {
        if !crate::node_link::contract_valid("ColdSnapshotCaptureRequest", value) {
            return Value::Null;
        }
        let Ok(request) = serde_json::from_value::<Request>(value.clone()) else {
            return Value::Null;
        };
        if self.capture_cancel_path(&request.operation).exists() {
            return self.cancel_cold_snapshot_capture(&identity(value));
        }
        if request.source_node_id != node_id {
            return failed(value, "snapshot_wrong_node", true);
        }
        let directory = self.captures_directory();
        if create_private_directory(&directory).is_err() {
            return failed(value, "snapshot_journal_unavailable", false);
        }
        let path = directory.join(format!("{}.json", request.operation));
        let mut journal = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(journal)
                    if journal["request_sha256"] == digest(value)
                        && journal["request"] == *value =>
                {
                    journal
                }
                _ => return failed(value, "snapshot_journal_conflict", false),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let journal = json!({"request":value,"request_sha256":digest(value),"result":null,"acknowledged":false});
                if write_private(&path, journal.to_string().as_bytes()).is_err() {
                    return failed(value, "snapshot_journal_unavailable", false);
                }
                journal
            }
            Err(_) => return failed(value, "snapshot_journal_unavailable", false),
        };
        if !journal["result"].is_null() {
            return journal["result"].clone();
        }
        let captured = async {
            if self.fences.fenced() || self.maintenance.load(Ordering::SeqCst) {
                return Err("snapshot_node_unavailable");
            }
            let db = self
                .find(&request.database_id)
                .ok_or("snapshot_source_missing")?;
            let _flow = db.lock.lock().await;
            if !self.capture_source_matches(&request, &db) {
                return Err("snapshot_source_changed");
            }
            let volume = VolumeId::new(&request.database_id, request.source_storage_generation)
                .map_err(|_| "snapshot_identity_invalid")?;
            if !self.machine.attached(&volume)
                || !matches!(self.machine.has_volume(&volume).await, Ok(true))
                || self
                    .machine
                    .unit(&request.database_id)
                    .await
                    .map_or(true, |unit| unit.active.awake())
            {
                return Err("snapshot_source_unavailable");
            }
            let data = self.layout().data(&request.database_id);
            let _lock = crate::units::slots::DataLock::try_new(&data)
                .map_err(|_| "snapshot_source_running")?;
            proof::wake_check(
                Some(&request.end),
                &self.layout().volume(&request.database_id),
            )
            .map_err(|_| "snapshot_control_mismatch")?;
            let transport = self.cold_snapshot_transport(&request.operation)?;
            let _slot = self
                .jobs
                .snapshot_slot()
                .await
                .map_err(|_| "snapshot_busy")?;
            // Sealing may have committed even when its response was lost. A known source
            // change must still take precedence over the transport error that the API can
            // otherwise reconcile from its sealed record.
            let transferred =
                cold_snapshot::capture_and_upload(&data, &request.binding(), &*transport).await;
            proof::wake_check(
                Some(&request.end),
                &self.layout().volume(&request.database_id),
            )
            .map_err(|_| "snapshot_control_mismatch")?;
            if !self.capture_source_matches(&request, &db) {
                return Err("snapshot_source_changed");
            }
            transferred
        };
        let result = match tokio::select! { result=captured=>result, ()=cancel.wait()=>Err("snapshot_capture_cancelled") }
        {
            Ok(manifest) => {
                let mut result = identity(value);
                result["status"] = json!("captured");
                result["observed_at"] = facts::timestamp(super::now_ms()).into();
                match (manifest.sha256(), manifest.encode()) {
                    (Ok(hash), Ok(bytes)) => {
                        result["manifest_sha256"] = hash.into();
                        result["manifest_bytes"] = (bytes.len() as u64).into();
                        result["end"] = request.end.observation();
                        result["cleaned_up"] = true.into();
                        result
                    }
                    _ => failed(value, "snapshot_manifest_invalid", true),
                }
            }
            Err(reason) => failed(value, reason, true),
        };
        journal["result"] = result.clone();
        if write_private(&path, journal.to_string().as_bytes()).is_err() {
            return failed(value, "snapshot_journal_unavailable", false);
        }
        result
    }
    /// Reissue unacknowledged capture receipts even when the desired task has disappeared.
    pub(crate) fn resend_cold_capture_receipts(
        &self,
        active: &HashSet<String>,
        running: &HashSet<String>,
    ) {
        let Ok(files) = std::fs::read_dir(self.captures_directory()) else {
            return;
        };
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
            let owner = journal
                .get("request")
                .or_else(|| journal.get("cancellation"));
            if let Some(owner) = owner
                && let Some(operation) = owner["operation"].as_str()
                && !active.contains(operation)
                && !running.contains(&format!("capture:{operation}"))
                && (journal["result"].is_null() || journal["result"]["cleaned_up"] == false)
            {
                self.report_cold_snapshot_capture(
                    self.cancel_cold_snapshot_capture(&identity(owner)),
                );
                continue;
            }
            let result = &journal["result"];
            if journal["acknowledged"] == true
                || result.is_null()
                || !crate::node_link::contract_valid("ColdSnapshotCaptureResult", result)
            {
                continue;
            }
            if result["operation"]
                .as_str()
                .is_some_and(|op| running.contains(&format!("capture:{op}")))
            {
                continue;
            }
            self.report_cold_snapshot_capture(result.clone());
        }
    }
    pub(crate) fn cold_snapshot_capture_posted(&self, result: &Value) {
        if !crate::node_link::contract_valid("ColdSnapshotCaptureResult", result)
            || result["cleaned_up"] != true
        {
            return;
        }
        let operation = result["operation"].as_str().expect("validated operation");
        for path in [
            self.captures_directory().join(format!("{operation}.json")),
            self.capture_cancel_path(operation),
        ] {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(mut journal) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if journal["result"] != *result {
                continue;
            }
            journal["acknowledged"] = true.into();
            let _ = write_private(&path, journal.to_string().as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            cold::tests::sleeping,
            testing::{Rig, eventually},
        },
        archive::cold_snapshot::{Store, Transfer, Transport},
        link::Order,
    };

    struct LostSealStore {
        store: Arc<dyn Store>,
        after_seal: Arc<dyn Fn() + Send + Sync>,
    }
    struct LostSeal {
        transport: Arc<dyn Transport>,
        after_seal: Arc<dyn Fn() + Send + Sync>,
    }
    impl Store for LostSealStore {
        fn operation(&self, operation: &str) -> Arc<dyn Transport> {
            Arc::new(LostSeal {
                transport: self.store.operation(operation),
                after_seal: self.after_seal.clone(),
            })
        }
    }
    impl Transport for LostSeal {
        fn put_manifest<'a>(&'a self, bytes: &'a [u8], sha256: &'a str) -> Transfer<'a, ()> {
            self.transport.put_manifest(bytes, sha256)
        }
        fn get_manifest(&self) -> Transfer<'_, Vec<u8>> {
            self.transport.get_manifest()
        }
        fn put_chunk<'a>(
            &'a self,
            index: u32,
            bytes: &'a [u8],
            sha256: &'a str,
        ) -> Transfer<'a, ()> {
            self.transport.put_chunk(index, bytes, sha256)
        }
        fn get_chunk(&self, index: u32) -> Transfer<'_, Vec<u8>> {
            self.transport.get_chunk(index)
        }
        fn seal<'a>(&'a self, sha256: &'a str) -> Transfer<'a, ()> {
            Box::pin(async move {
                self.transport.seal(sha256).await?;
                (self.after_seal)();
                Err("cold_snapshot_transfer_failed")
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lost_seal_response_cannot_hide_a_changed_source_generation() {
        let Some(rig) = Rig::new("capture-lost-seal").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (_, db, entry) = sleeping(&rig).await;
        let operation = "op_qqqqqqqqqqqqqqqqqqqq";
        rig.core
            .apply(&Rig::page(
                vec![entry.clone()],
                vec![Order::Move {
                    operation: operation.into(),
                    database: db.id.clone(),
                    storage_generation: 1,
                }],
            ))
            .await;
        eventually(30, "new capture source hold", || {
            rig.core.pending_order(operation).is_some()
                && db.view().moving.as_deref() == Some(operation)
        })
        .await;
        let mut changed = rig.entry_for(&entry);
        changed.generation += 1;
        let (core, handle) = (rig.core.clone(), db.clone());
        rig.core.set_cold_snapshot_store(Arc::new(LostSealStore {
            store: rig.cold_store.clone(),
            after_seal: Arc::new(move || {
                assert!(core.accept(&handle, changed.clone()));
            }),
        }));
        let request = json!({"operation":operation,"database_id":db.id,"source_node_id":"nod_aaaaaaaaaaaaaaaaaaaa","source_generation":entry["generation"],"source_storage_generation":1,"end":db.state().unwrap().record.unwrap().observation()});
        let result = rig
            .core
            .capture_cold_snapshot(
                &request,
                "nod_aaaaaaaaaaaaaaaaaaaa",
                &VerificationCancellation::default(),
            )
            .await;
        assert!(
            rig.cold_store
                .operation(operation)
                .get_manifest()
                .await
                .is_ok(),
            "seal committed before its response was lost"
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(
            result["reason"], "snapshot_source_changed",
            "a known source change must not be downgraded to a reconcilable transport uncertainty"
        );
        assert_eq!(result["cleaned_up"], true);
        assert!(
            rig.machine
                .has_volume(&VolumeId::new(&db.id, 1).unwrap())
                .await
                .unwrap()
        );
    }
}
