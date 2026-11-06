// SPDX-License-Identifier: Apache-2.0
//! Functional snapshot object storage for tests: real bytes and hashes, immutable conditional
//! writes, and explicit fault/cancellation controls. Never compiled into the node binary.
use super::cold_snapshot::{
    BoxFuture, CHUNK_BYTES, MANIFEST_MAX_BYTES, Manifest, Store, Transport,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::watch;

#[derive(Default)]
struct Objects {
    manifest: Option<Vec<u8>>,
    chunks: HashMap<u32, Vec<u8>>,
    writes: usize,
    sealed: bool,
}
struct Inner {
    objects: Mutex<HashMap<String, Objects>>,
    blocked: watch::Sender<bool>,
    reads: AtomicUsize,
}
#[derive(Clone)]
pub(crate) struct MemoryStore {
    inner: Arc<Inner>,
}
impl Default for MemoryStore {
    fn default() -> Self {
        let (blocked, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner {
                objects: Mutex::new(HashMap::new()),
                blocked,
                reads: AtomicUsize::new(0),
            }),
        }
    }
}
impl MemoryStore {
    pub(crate) fn manifest(&self, operation: &str) -> Option<Vec<u8>> {
        self.inner
            .objects
            .lock()
            .unwrap()
            .get(operation)?
            .manifest
            .clone()
    }
    pub(crate) fn chunk(&self, operation: &str, index: u32) -> Option<Vec<u8>> {
        self.inner
            .objects
            .lock()
            .unwrap()
            .get(operation)?
            .chunks
            .get(&index)
            .cloned()
    }
    pub(crate) fn remove_chunk(&self, operation: &str, index: u32) {
        if let Some(objects) = self.inner.objects.lock().unwrap().get_mut(operation) {
            objects.chunks.remove(&index);
        }
    }
    pub(crate) fn replace_chunk(&self, operation: &str, index: u32, bytes: Vec<u8>) {
        self.inner
            .objects
            .lock()
            .unwrap()
            .entry(operation.into())
            .or_default()
            .chunks
            .insert(index, bytes);
    }
    pub(crate) fn replace_manifest(&self, operation: &str, bytes: Vec<u8>) {
        self.inner
            .objects
            .lock()
            .unwrap()
            .entry(operation.into())
            .or_default()
            .manifest = Some(bytes);
    }
    pub(crate) fn writes(&self, operation: &str) -> usize {
        self.inner
            .objects
            .lock()
            .unwrap()
            .get(operation)
            .map_or(0, |objects| objects.writes)
    }
    pub(crate) fn block_reads(&self) {
        self.inner.blocked.send_replace(true);
    }
    pub(crate) fn release_reads(&self) {
        self.inner.blocked.send_replace(false);
    }
    pub(crate) fn reads(&self) -> usize {
        self.inner.reads.load(Ordering::SeqCst)
    }
}
struct Scoped {
    inner: Arc<Inner>,
    operation: String,
}
impl Store for MemoryStore {
    fn operation(&self, operation: &str) -> Arc<dyn Transport> {
        Arc::new(Scoped {
            inner: self.inner.clone(),
            operation: operation.into(),
        })
    }
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
impl Transport for Scoped {
    fn put_manifest<'a>(&'a self, bytes: &'a [u8], sha256: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if bytes.len() > MANIFEST_MAX_BYTES || digest(bytes) != sha256 {
                return Err("snapshot_manifest_mismatch");
            }
            let manifest = Manifest::decode(bytes, sha256)?;
            if manifest.operation != self.operation {
                return Err("snapshot_identity_mismatch");
            }
            let mut objects = self.inner.objects.lock().unwrap();
            let held = objects.entry(self.operation.clone()).or_default();
            if let Some(previous) = &held.manifest {
                return if previous == bytes {
                    Ok(())
                } else {
                    Err("snapshot_object_conflict")
                };
            }
            held.manifest = Some(bytes.to_vec());
            held.writes += 1;
            Ok(())
        })
    }
    fn get_manifest(&self) -> BoxFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.inner
                .objects
                .lock()
                .unwrap()
                .get(&self.operation)
                .filter(|objects| objects.sealed)
                .and_then(|objects| objects.manifest.clone())
                .ok_or("snapshot_manifest_missing")
        })
    }
    fn put_chunk<'a>(&'a self, index: u32, bytes: &'a [u8], sha256: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if bytes.is_empty() || bytes.len() > CHUNK_BYTES || digest(bytes) != sha256 {
                return Err("snapshot_chunk_mismatch");
            }
            let mut objects = self.inner.objects.lock().unwrap();
            let held = objects.entry(self.operation.clone()).or_default();
            let manifest_bytes = held.manifest.as_ref().ok_or("snapshot_undeclared")?;
            let manifest = Manifest::decode(manifest_bytes, &digest(manifest_bytes))?;
            let declared = manifest
                .chunks
                .get(index as usize)
                .ok_or("snapshot_chunk_undeclared")?;
            if declared.index != index
                || declared.size_bytes as usize != bytes.len()
                || declared.sha256 != sha256
            {
                return Err("snapshot_chunk_mismatch");
            }
            if let Some(previous) = held.chunks.get(&index) {
                return if previous == bytes {
                    Ok(())
                } else {
                    Err("snapshot_object_conflict")
                };
            }
            if held.sealed {
                return Err("snapshot_sealed");
            }
            held.chunks.insert(index, bytes.to_vec());
            held.writes += 1;
            Ok(())
        })
    }
    fn seal<'a>(&'a self, manifest_sha256: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let mut objects = self.inner.objects.lock().unwrap();
            let held = objects
                .get_mut(&self.operation)
                .ok_or("snapshot_undeclared")?;
            let bytes = held.manifest.as_ref().ok_or("snapshot_undeclared")?;
            let manifest = Manifest::decode(bytes, manifest_sha256)?;
            for chunk in &manifest.chunks {
                let bytes = held
                    .chunks
                    .get(&chunk.index)
                    .ok_or("snapshot_chunk_missing")?;
                if bytes.len() != chunk.size_bytes as usize || digest(bytes) != chunk.sha256 {
                    return Err("snapshot_chunk_mismatch");
                }
            }
            held.sealed = true;
            Ok(())
        })
    }
    fn get_chunk(&self, index: u32) -> BoxFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.inner.reads.fetch_add(1, Ordering::SeqCst);
            let mut blocked = self.inner.blocked.subscribe();
            while *blocked.borrow_and_update() {
                blocked
                    .changed()
                    .await
                    .map_err(|_| "snapshot_store_closed")?;
            }
            self.inner
                .objects
                .lock()
                .unwrap()
                .get(&self.operation)
                .and_then(|objects| objects.chunks.get(&index).cloned())
                .ok_or("snapshot_chunk_missing")
        })
    }
}
