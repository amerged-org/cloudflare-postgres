// SPDX-License-Identifier: Apache-2.0
//! One node-local expiry supervisor. Network refresh never blocks the local stop clock.
use crate::{
    controller::SandboxController,
    policy::{Client, StorageAuthorityTrust},
};
use pgcf_native_protocol::storage::{StorageTrust, StorageWriteClaims, VerifiedStorageAuthority};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tonic::Status;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostStorageLease {
    pub purpose: String,
    pub node_uid: String,
    pub boot_id: Option<String>,
    pub material_revision: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub legacy: Vec<Legacy>,
    pub databases: Vec<Entry>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Legacy {
    database_id: String,
    generation: u64,
    namespace: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    database_id: String,
    generation: u64,
    authority_revision: u64,
    write_blocked: bool,
    desired_state: String,
    node_uid: String,
    volume_group_uuid: String,
    pool_uuid: String,
    profile_sha256: String,
    startup_expires_at: Option<u64>,
    startup_operation_id: Option<String>,
    volume: Option<serde_json::Value>,
    runtime_authority: Option<String>,
    #[serde(default)]
    drain: Option<Drain>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Drain {
    operation_id: String,
    kind: String,
    generation: u64,
    authority_revision: u64,
    expires_at: u64,
    budget_bytes: u64,
}
#[derive(Clone)]
struct Accepted {
    entry: Entry,
    runtime: Option<VerifiedStorageAuthority>,
    received: Instant,
    remaining: Duration,
}
struct ResumeScope {
    authority: VerifiedStorageAuthority,
    expires_at: u64,
    deadline: Instant,
    operation_id: Option<String>,
    drain_only: bool,
}
impl ResumeScope {
    fn current(&self, now: u64) -> bool {
        now < self.expires_at && Instant::now() < self.deadline
    }
}
#[derive(Clone)]
pub struct Guard {
    trust: StorageTrust,
    node_uid: String,
    boot_id: String,
    material_revision: u64,
    stopped: BTreeSet<String>,
    quiesced: BTreeSet<String>,
    resumed: BTreeMap<String, (String, bool)>,
    last_issued: u64,
    snapshot_expires_at: u64,
    snapshot_deadline: Option<Instant>,
    snapshot_material_revision: u64,
    entries: BTreeMap<String, Accepted>,
    // Bound thick IDs cannot become thin in place. Only a fresh CF snapshot changes this cohort.
    legacy: BTreeSet<String>,
    highest: BTreeMap<String, VerifiedStorageAuthority>,
}
fn invalid() -> Status {
    Status::failed_precondition("storage_host_authority_invalid")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
pub fn current_boot_id() -> Result<String, Status> {
    let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|_| invalid())?
        .trim()
        .to_owned();
    if id.len() != 36 {
        return Err(invalid());
    }
    Ok(id)
}
fn same_physical_scope(a: &StorageWriteClaims, b: &StorageWriteClaims) -> bool {
    a.database_id == b.database_id
        && a.storage_uid == b.storage_uid
        && a.node_uid == b.node_uid
        && a.volume_group_uuid == b.volume_group_uuid
        && a.pool_uuid == b.pool_uuid
        && a.profile_sha256 == b.profile_sha256
        && a.volume_handle == b.volume_handle
        && a.lv_uuid == b.lv_uuid
        && a.pvc_uid == b.pvc_uid
        && a.pv_uid == b.pv_uid
}
fn receipt_matches(entry: &Entry, c: &pgcf_native_protocol::storage::StorageWriteClaims) -> bool {
    let Some(v) = entry.volume.as_ref() else {
        return false;
    };
    entry.node_uid == c.node_uid
        && entry.volume_group_uuid == c.volume_group_uuid
        && entry.pool_uuid == c.pool_uuid
        && entry.profile_sha256 == c.profile_sha256
        && v["node_uid"] == c.node_uid
        && v["volume_group_uuid"] == c.volume_group_uuid
        && v["pool_uuid"] == c.pool_uuid
        && v["storage_uid"] == c.storage_uid
        && v["volume_handle"] == c.volume_handle
        && v["lv_uuid"] == c.lv_uuid
        && v["pvc_uid"] == c.pvc_uid
        && v["pv_uid"] == c.pv_uid
}
impl Guard {
    pub fn new(
        config: StorageAuthorityTrust,
        node_uid: String,
        material_revision: u64,
    ) -> Result<Self, Status> {
        if config.legacy_database_ids.len() > 2000
            || config
                .legacy_database_ids
                .iter()
                .any(|id| !pgcf_native_protocol::valid_pattern("database", id))
        {
            return Err(invalid());
        }
        let public = serde_json::to_string(&config.keys).map_err(|_| invalid())?;
        Ok(Self {
            trust: StorageTrust::parse(&public, &config.sha256).map_err(|_| invalid())?,
            node_uid,
            boot_id: current_boot_id()?,
            stopped: BTreeSet::new(),
            quiesced: BTreeSet::new(),
            resumed: BTreeMap::new(),
            material_revision,
            last_issued: 0,
            snapshot_expires_at: 0,
            snapshot_deadline: None,
            snapshot_material_revision: 0,
            entries: BTreeMap::new(),
            legacy: config.legacy_database_ids.into_iter().collect(),
            highest: BTreeMap::new(),
        })
    }
    pub fn accept(&mut self, lease: HostStorageLease, now: u64) -> Result<(), Status> {
        let value = serde_json::to_value(&lease).map_err(|_| invalid())?;
        let schema = jsonschema::validator_for(&pgcf_native_protocol::CONTRACT["storageHostLease"])
            .map_err(|_| invalid())?;
        if !schema.is_valid(&value)
            || lease.purpose != "pgcf-storage-host/v1"
            || lease.node_uid != self.node_uid
            || (!lease.databases.is_empty()
                && lease.boot_id.as_deref() != Some(self.boot_id.as_str()))
            || lease.material_revision != self.material_revision
            || lease.issued_at < self.last_issued
            || lease.issued_at > now.saturating_add(5000)
            || lease.expires_at <= now
            || lease.expires_at <= lease.issued_at
            || lease.expires_at > lease.issued_at.saturating_add(120000)
        {
            return Err(invalid());
        }
        let mut entries = BTreeMap::new();
        let mut names = BTreeSet::new();
        for entry in lease.databases {
            if entry.node_uid != self.node_uid
                || !names.insert(entry.database_id.clone())
                || entry
                    .startup_expires_at
                    .is_some_and(|expiry| expiry > lease.expires_at)
            {
                return Err(invalid());
            }
            if let Some(drain) = &entry.drain
                && (entry.desired_state == "running"
                    || entry.volume.is_none()
                    || entry.startup_expires_at.is_some()
                    || entry.startup_operation_id.is_some()
                    || entry.runtime_authority.is_some()
                    || drain.generation != entry.generation
                    || drain.authority_revision != entry.authority_revision
                    || drain.expires_at > lease.expires_at
                    || (entry.desired_state == "deleted" && drain.kind != "database.delete")
                    || (entry.desired_state == "suspended"
                        && !["database.suspend", "database.hibernate"]
                            .contains(&drain.kind.as_str())))
            {
                return Err(invalid());
            }
            let runtime = match &entry.runtime_authority {
                None => self
                    .entries
                    .get(&entry.database_id)
                    .and_then(|previous| previous.runtime.as_ref())
                    .filter(|old| {
                        let c = old.claims();
                        entry.desired_state == "running"
                            && !entry.write_blocked
                            && entry.generation == c.generation
                            && entry.authority_revision == c.authority_revision
                            && receipt_matches(&entry, c)
                            && c.valid_at(now)
                    })
                    .cloned(),
                Some(token) => {
                    let verified = self.trust.verify(token, now).map_err(|_| invalid())?;
                    let claims = verified.claims();
                    if claims.database_id != entry.database_id
                        || claims.generation != entry.generation
                        || claims.authority_revision != entry.authority_revision
                        || claims.node_uid != entry.node_uid
                        || claims.volume_group_uuid != entry.volume_group_uuid
                        || claims.pool_uuid != entry.pool_uuid
                        || claims.profile_sha256 != entry.profile_sha256
                    {
                        return Err(invalid());
                    }
                    if self
                        .highest
                        .get(&entry.database_id)
                        .is_some_and(|verified| {
                            let old = verified.claims();
                            !same_physical_scope(claims, old)
                                || (claims.pod_uid != old.pod_uid
                                    && claims.generation <= old.generation)
                                || claims.authority_revision < old.authority_revision
                                || (claims.authority_revision == old.authority_revision
                                    && claims != old)
                        })
                    {
                        return Err(invalid());
                    }
                    Some(verified)
                }
            };
            let expires = runtime
                .as_ref()
                .map(|verified| verified.claims().exp)
                .or(entry.startup_expires_at)
                .or(entry.drain.as_ref().map(|drain| drain.expires_at))
                .unwrap_or(now)
                .min(lease.expires_at);
            let mut remaining = Duration::from_millis(expires.saturating_sub(now));
            if let Some(previous) = self.entries.get(&entry.database_id)
                && previous.entry.generation == entry.generation
                && previous.entry.node_uid == entry.node_uid
                && previous.entry.volume_group_uuid == entry.volume_group_uuid
                && previous.entry.pool_uuid == entry.pool_uuid
                && previous.entry.profile_sha256 == entry.profile_sha256
                && previous.runtime.as_ref().map(|v| v.claims())
                    == runtime.as_ref().map(|v| v.claims())
                && previous.entry.startup_expires_at == entry.startup_expires_at
                && previous.entry.drain == entry.drain
            {
                remaining = remaining.min(
                    previous
                        .remaining
                        .saturating_sub(previous.received.elapsed()),
                );
            }
            entries.insert(
                entry.database_id.clone(),
                Accepted {
                    entry,
                    runtime,
                    received: Instant::now(),
                    remaining,
                },
            );
        }
        let mut legacy = BTreeSet::new();
        for entry in lease.legacy {
            if entry.generation == 0
                || entry.namespace != format!("pgcf-db-{}", entry.database_id)
                || !names.insert(entry.database_id.clone())
            {
                return Err(invalid());
            }
            legacy.insert(entry.database_id);
        }
        for (id, accepted) in &entries {
            if let Some(runtime) = &accepted.runtime {
                // A new CF-owned running generation is a new actual task lifetime, even when
                // Kubernetes reuses the same Pod UID. Ordinary lease renewals keep old stop facts.
                if self
                    .highest
                    .get(id)
                    .is_some_and(|old| runtime.claims().generation > old.claims().generation)
                {
                    self.stopped.remove(&runtime.claims().pod_uid);
                    self.quiesced.remove(&runtime.claims().pod_uid);
                    self.resumed.remove(&runtime.claims().pod_uid);
                }
                self.highest.insert(id.clone(), runtime.clone());
            }
        }
        let mut deadline =
            Instant::now() + Duration::from_millis(lease.expires_at.saturating_sub(now));
        if self.last_issued == lease.issued_at
            && self.snapshot_expires_at == lease.expires_at
            && let Some(old) = self.snapshot_deadline
        {
            deadline = deadline.min(old);
        }
        self.snapshot_deadline = Some(deadline);
        self.snapshot_expires_at = lease.expires_at;
        self.snapshot_material_revision = lease.material_revision;
        self.entries = entries;
        self.legacy = legacy;
        self.last_issued = lease.issued_at;
        Ok(())
    }
    pub fn rebind_material_revision(&mut self, next: u64, legacy: &[String]) -> Result<(), Status> {
        if next < self.material_revision
            || legacy.len() > 2000
            || legacy
                .iter()
                .any(|id| !pgcf_native_protocol::valid_pattern("database", id))
        {
            return Err(invalid());
        }
        self.material_revision = next;
        self.legacy.extend(legacy.iter().cloned());
        Ok(())
    }
    pub fn note_stopped(&mut self, pod_uid: &str) {
        self.stopped.insert(pod_uid.to_owned());
    }
    pub fn note_quiesced(&mut self, pod_uid: &str) {
        self.quiesced.insert(pod_uid.to_owned());
        self.resumed.remove(pod_uid);
    }
    pub fn note_resumed(&mut self, pod_uid: &str, operation_id: &str, drain_only: bool) {
        self.quiesced.remove(pod_uid);
        self.resumed
            .insert(pod_uid.to_owned(), (operation_id.to_owned(), drain_only));
    }
    fn resumed_for(&self, pod_uid: &str, operation_id: &str, drain_only: bool) -> bool {
        !self.quiesced.contains(pod_uid)
            && self
                .resumed
                .get(pod_uid)
                .is_some_and(|(op, drain)| op == operation_id && *drain == drain_only)
    }
    pub fn protective_pods(&self) -> Vec<(String, String)> {
        self.highest
            .values()
            .map(|scope| {
                (
                    scope.claims().pod_uid.clone(),
                    format!("pgcf-db-{}", scope.claims().database_id),
                )
            })
            .collect()
    }
    pub fn permits_create(&self, namespace: &str, pod_uid: &str, now: u64) -> bool {
        if !self.permits(namespace, pod_uid, now) {
            return false;
        }
        let Some(id) = namespace.strip_prefix("pgcf-db-") else {
            return true;
        };
        if self.legacy.contains(id) {
            return true;
        }
        self.highest.get(id).is_none_or(|old| {
            self.stopped.contains(&old.claims().pod_uid)
                && self
                    .entries
                    .get(id)
                    .and_then(|entry| entry.entry.startup_operation_id.as_deref())
                    .is_some_and(|operation| {
                        self.resumed_for(&old.claims().pod_uid, operation, false)
                    })
                && !self.quiesced.contains(&old.claims().pod_uid)
                && self
                    .entries
                    .get(id)
                    .is_some_and(|entry| entry.entry.generation > old.claims().generation)
        })
    }
    fn drain_scope<'a>(
        &'a self,
        namespace: &str,
        pod_uid: &str,
        now: u64,
    ) -> Option<(&'a Accepted, &'a VerifiedStorageAuthority, &'a Drain)> {
        let id = namespace.strip_prefix("pgcf-db-")?;
        let accepted = self.entries.get(id)?;
        let old = self.highest.get(id)?;
        let drain = accepted.entry.drain.as_ref()?;
        (accepted.entry.desired_state != "running"
            && accepted.entry.generation > old.claims().generation
            && drain.authority_revision > old.claims().authority_revision
            && drain.expires_at > now
            && accepted.received.elapsed() < accepted.remaining
            && old.claims().pod_uid == pod_uid
            && receipt_matches(&accepted.entry, old.claims()))
        .then_some((accepted, old, drain))
    }
    fn active_drain(&self, namespace: &str, pod_uid: &str, now: u64) -> bool {
        self.drain_scope(namespace, pod_uid, now)
            .is_some_and(|(_, _, drain)| self.resumed_for(pod_uid, &drain.operation_id, true))
    }
    fn resume_scope(&self, namespace: &str, pod_uid: &str, now: u64) -> Option<ResumeScope> {
        if let Some((accepted, old, drain)) = self.drain_scope(namespace, pod_uid, now) {
            return (!self.resumed_for(pod_uid, &drain.operation_id, true)).then(|| ResumeScope {
                authority: old.clone(),
                expires_at: drain.expires_at,
                deadline: accepted.received + accepted.remaining,
                operation_id: Some(drain.operation_id.clone()),
                drain_only: true,
            });
        }
        let id = namespace.strip_prefix("pgcf-db-")?;
        let accepted = self.entries.get(id)?;
        let old = self.highest.get(id)?;
        let operation = accepted.entry.startup_operation_id.as_ref()?;
        ((!self.stopped.contains(pod_uid) || !self.resumed_for(pod_uid, operation, false))
            && accepted.entry.desired_state == "running"
            && accepted.entry.generation > old.claims().generation
            && accepted
                .entry
                .startup_expires_at
                .is_some_and(|exp| exp > now)
            && accepted.received.elapsed() < accepted.remaining
            && old.claims().pod_uid == pod_uid
            && receipt_matches(&accepted.entry, old.claims()))
        .then(|| ResumeScope {
            authority: old.clone(),
            expires_at: accepted.entry.startup_expires_at.unwrap_or(0),
            deadline: accepted.received + accepted.remaining,
            operation_id: Some(operation.clone()),
            drain_only: false,
        })
    }
    fn retirement_scope(&self, namespace: &str, pod_uid: &str, now: u64) -> Option<ResumeScope> {
        let id = namespace.strip_prefix("pgcf-db-")?;
        let entry = &self.entries.get(id)?.entry;
        let old = self.highest.get(id)?;
        let deadline = self.snapshot_deadline?;
        (self.snapshot_material_revision == self.material_revision
            && self.snapshot_expires_at > now
            && Instant::now() < deadline
            && self.stopped.contains(pod_uid)
            && old.claims().pod_uid == pod_uid
            && entry.desired_state == "deleted"
            && !entry.write_blocked
            && entry.volume.is_none()
            && entry.generation >= old.claims().generation
            && entry.authority_revision > old.claims().authority_revision
            && entry.node_uid == old.claims().node_uid
            && entry.volume_group_uuid == old.claims().volume_group_uuid
            && entry.pool_uuid == old.claims().pool_uuid
            && entry.profile_sha256 == old.claims().profile_sha256)
            .then(|| ResumeScope {
                authority: old.clone(),
                expires_at: self.snapshot_expires_at,
                deadline,
                operation_id: None,
                drain_only: false,
            })
    }
    fn forget_protective(&mut self, pod_uid: &str) {
        self.highest.retain(|_, v| v.claims().pod_uid != pod_uid);
        self.stopped.remove(pod_uid);
        self.quiesced.remove(pod_uid);
        self.resumed.remove(pod_uid);
    }
    pub fn permits(&self, namespace: &str, pod_uid: &str, now: u64) -> bool {
        let Some(id) = namespace.strip_prefix("pgcf-db-") else {
            return true;
        };
        if self.legacy.contains(id) {
            return true;
        }
        let Some(accepted) = self.entries.get(id) else {
            return false;
        };
        self.permits_at(accepted, pod_uid, now, accepted.received.elapsed())
    }
    pub fn retain_protective(&mut self, pod_uid: &str, token: &str) -> Result<(), Status> {
        let authority = self
            .trust
            .verify_for_protection(token)
            .map_err(|_| invalid())?;
        let claims = authority.claims();
        if claims.node_uid != self.node_uid || claims.pod_uid != pod_uid {
            return Err(invalid());
        }
        if self.highest.get(&claims.database_id).is_some_and(|old| {
            !same_physical_scope(claims, old.claims())
                || (claims.authority_revision == old.claims().authority_revision
                    && claims != old.claims())
        }) {
            return Err(invalid());
        }
        if self
            .highest
            .get(&claims.database_id)
            .is_none_or(|old| old.claims().authority_revision < claims.authority_revision)
        {
            self.highest.insert(claims.database_id.clone(), authority);
        }
        Ok(())
    }
    pub fn protection(&self, namespace: &str, pod_uid: &str) -> Option<VerifiedStorageAuthority> {
        self.highest
            .get(namespace.strip_prefix("pgcf-db-")?)
            .filter(|authority| authority.claims().pod_uid == pod_uid)
            .cloned()
    }
    fn permits_at(&self, accepted: &Accepted, pod_uid: &str, now: u64, elapsed: Duration) -> bool {
        if elapsed >= accepted.remaining
            || accepted.entry.write_blocked
            || accepted.entry.desired_state != "running"
        {
            return false;
        }
        if let Some(verified) = &accepted.runtime {
            let runtime = verified.claims();
            return runtime.write_allowed && runtime.valid_at(now) && runtime.pod_uid == pod_uid;
        }
        accepted
            .entry
            .startup_expires_at
            .is_some_and(|expiry| expiry > now)
    }
}
pub async fn watch(
    controller: SandboxController,
    mut client: Client,
    _trust: StorageAuthorityTrust,
    mut updates: tokio::sync::watch::Receiver<Client>,
) {
    let Some(guard) = controller.storage_guard() else {
        eprintln!("storage_guard_unavailable");
        return;
    };
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let fetch_guard = guard.clone();
    let fetcher = tokio::spawn(async move {
        loop {
            if updates.has_changed().unwrap_or(false) {
                client = updates.borrow_and_update().clone();
                let local = client.local();
                let legacy = local
                    .storage_authority
                    .as_ref()
                    .map(|t| t.legacy_database_ids.as_slice())
                    .unwrap_or(&[]);
                if let Err(error) = fetch_guard
                    .lock()
                    .await
                    .rebind_material_revision(u64::from(local.material_revision), legacy)
                {
                    eprintln!("{}", error.message());
                    return;
                }
            }
            if let Ok(lease) = client.storage_lease().await
                && tx.send(lease).await.is_err()
            {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    supervise_shared(controller, guard, rx).await;
    fetcher.abort();
}
/// The exact same loop is exercised by the isolated real containerd/PostgreSQL proof.
pub async fn supervise(
    controller: SandboxController,
    guard: Guard,
    rx: tokio::sync::mpsc::Receiver<HostStorageLease>,
) {
    supervise_shared(controller, Arc::new(tokio::sync::Mutex::new(guard)), rx).await;
}
/// Exercise the same configured guard used by task creation and production lease supervision.
pub async fn supervise_bound(
    controller: SandboxController,
    rx: tokio::sync::mpsc::Receiver<HostStorageLease>,
) {
    let Some(guard) = controller.storage_guard() else {
        return;
    };
    supervise_shared(controller, guard, rx).await;
}
async fn supervise_shared(
    controller: SandboxController,
    guard: Arc<tokio::sync::Mutex<Guard>>,
    mut rx: tokio::sync::mpsc::Receiver<HostStorageLease>,
) {
    let mut stopping = BTreeSet::<String>::new();
    let (done_tx, mut done_rx) =
        tokio::sync::mpsc::channel::<(String, bool, Option<bool>, bool, Option<(String, bool)>)>(
            256,
        );
    let (accepted_tx, mut accepted_rx) = tokio::sync::mpsc::channel(1);
    let persist_controller = controller.clone();
    let persist_guard = guard.clone();
    tokio::spawn(async move {
        while let Some(lease) = rx.recv().await {
            let (trust, node_uid) = {
                let mut candidate = persist_guard.lock().await.clone();
                if let Err(error) = candidate.accept(lease.clone(), now()) {
                    eprintln!("{}", error.message());
                    continue;
                }
                (candidate.trust.clone(), candidate.node_uid.clone())
            };
            let mut persisted = true;
            for entry in &lease.databases {
                let Some(token) = &entry.runtime_authority else {
                    continue;
                };
                let scope = match trust.verify(token, now()) {
                    Ok(scope)
                        if scope.claims().node_uid == node_uid
                            && scope.claims().database_id == entry.database_id
                            && scope.claims().generation == entry.generation =>
                    {
                        scope
                    }
                    _ => {
                        persisted = false;
                        break;
                    }
                };
                if let Err(error) = persist_controller
                    .remember_storage_authority(&scope.claims().pod_uid, token)
                    .await
                {
                    eprintln!("{}", error.message());
                    persisted = false;
                    break;
                }
                // Old private scope remains until its replacement signed physical scope is durable.
                for (old_uid, old_token) in persist_controller.retired_storage_authorities().await {
                    if let Ok(old) = trust.verify_for_protection(&old_token)
                        && same_physical_scope(scope.claims(), old.claims())
                        && scope.claims().generation > old.claims().generation
                        && let Err(error) = persist_controller
                            .forget_retired_storage_authority(&old_uid)
                            .await
                    {
                        eprintln!("{}", error.message());
                    }
                }
            }
            if persisted && accepted_tx.send(lease).await.is_err() {
                return;
            }
        }
    });
    loop {
        while let Ok(lease) = accepted_rx.try_recv() {
            if let Err(error) = guard.lock().await.accept(lease, now()) {
                eprintln!("{}", error.message());
            }
        }
        while let Ok((uid, stopped, quiesced, retired, resumed)) = done_rx.try_recv() {
            stopping.remove(&uid);
            let mut state = guard.lock().await;
            if retired {
                state.forget_protective(&uid);
                continue;
            }
            if quiesced == Some(true) {
                state.note_quiesced(&uid);
            }
            if let Some((operation, drain_only)) = resumed {
                state.note_resumed(&uid, &operation, drain_only);
            }
            if stopped {
                state.note_stopped(&uid);
            }
        }
        // Physical expiry cannot wait behind ordinary CRI holder cleanup under the pool lock.
        let mut pods = guard
            .lock()
            .await
            .protective_pods()
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        if let Ok(assigned) =
            tokio::time::timeout(Duration::from_millis(50), controller.assigned_pods()).await
        {
            for (uid, namespace) in assigned {
                pods.entry(uid).or_insert(namespace);
            }
        }
        for (uid, namespace) in pods {
            let (
                permit,
                protection,
                resume,
                retirement,
                was_stopped,
                was_quiesced,
                was_resumed,
                active_drain,
            ) = {
                let state = guard.lock().await;
                (
                    state.permits(&namespace, &uid, now()),
                    state.protection(&namespace, &uid),
                    state.resume_scope(&namespace, &uid, now()),
                    state.retirement_scope(&namespace, &uid, now()),
                    state.stopped.contains(&uid),
                    state.quiesced.contains(&uid),
                    state.resumed.contains_key(&uid),
                    state.active_drain(&namespace, &uid, now()),
                )
            };
            if (retirement.is_none()
                && resume.is_none()
                && ((permit && (!was_stopped || was_resumed))
                    || (was_stopped && (was_quiesced || active_drain))))
                || !stopping.insert(uid.clone())
            {
                continue;
            }
            let controller = controller.clone();
            let done = done_tx.clone();
            tokio::spawn(async move {
                if let Some(scope) = retirement {
                    let absent = tokio::task::spawn_blocking(move || {
                        if scope.current(now()) {
                            crate::storage_dm::absent(&scope.authority)
                        } else {
                            Err(Status::failed_precondition(
                                "storage_retirement_snapshot_expired",
                            ))
                        }
                    })
                    .await;
                    if matches!(absent, Ok(Ok(true)))
                        && controller
                            .forget_retired_storage_authority(&uid)
                            .await
                            .is_ok()
                    {
                        let _ = done.send((uid, true, None, true, None)).await;
                        return;
                    }
                    // A partial/changed kernel inventory never permits retirement.
                    let _ = done.send((uid, was_stopped, None, false, None)).await;
                    return;
                }
                let mut quiesced = None;
                let mut resumed = None;
                if let Some(scope) = resume {
                    let operation = scope
                        .operation_id
                        .clone()
                        .expect("only operation-bound resume scopes reach this branch");
                    let drain_only = scope.drain_only;
                    match tokio::task::spawn_blocking(move || {
                        if !scope.current(now()) {
                            return Err(Status::failed_precondition(
                                "storage_resume_startup_expired",
                            ));
                        }
                        crate::storage_dm::resume(&scope.authority)
                    })
                    .await
                    {
                        Ok(Ok(())) => {
                            quiesced = Some(false);
                            resumed = Some((operation, drain_only));
                        }
                        _ => {
                            eprintln!("storage_dm_resume_unconfirmed");
                            let _ = done.send((uid, false, None, false, None)).await;
                            return;
                        }
                    }
                } else if let Some(authority) =
                    protection.filter(|_| !was_quiesced && !active_drain)
                {
                    match tokio::task::spawn_blocking(move || {
                        crate::storage_dm::suspend(&authority)
                    })
                    .await
                    {
                        Ok(Ok(())) => {
                            quiesced = Some(true);
                        }
                        _ => eprintln!("storage_dm_quiescence_unconfirmed"),
                    }
                }
                let stopped = if was_stopped {
                    true
                } else {
                    match controller.stop_pod_tasks(&uid).await {
                        Ok(()) => true,
                        Err(error) => {
                            eprintln!("{}", error.message());
                            false
                        }
                    }
                };
                let _ = done.send((uid, stopped, quiesced, false, resumed)).await;
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn guard() -> Guard {
        let keys = BTreeMap::from([(
            "cf".to_owned(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        )]);
        let sha256 = Sha256::digest(serde_json::to_vec(&keys).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Guard::new(
            StorageAuthorityTrust {
                keys,
                sha256,
                legacy_database_ids: vec![],
            },
            "22222222-2222-4222-8222-222222222222".into(),
            1,
        )
        .unwrap()
    }
    fn lease() -> HostStorageLease {
        HostStorageLease {
            purpose: "pgcf-storage-host/v1".into(),
            node_uid: "22222222-2222-4222-8222-222222222222".into(),
            boot_id: Some(current_boot_id().unwrap()),
            material_revision: 1,
            issued_at: 1000,
            expires_at: 11000,
            legacy: vec![],
            databases: vec![Entry {
                database_id: "abcdefghijklmnopqrst".into(),
                generation: 1,
                authority_revision: 0,
                write_blocked: false,
                desired_state: "running".into(),
                node_uid: "22222222-2222-4222-8222-222222222222".into(),
                volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef".into(),
                pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg".into(),
                profile_sha256: "a".repeat(64),
                startup_expires_at: Some(11000),
                startup_operation_id: Some("op_abcdefghijklmnopqrst".into()),
                volume: None,
                runtime_authority: None,
                drain: None,
            }],
        }
    }
    #[test]
    fn only_a_new_cf_startup_can_resume_the_exact_retained_volume_before_its_deadline() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use ring::{
            rand::SystemRandom,
            signature::{Ed25519KeyPair, KeyPair},
        };
        let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
        let public = serde_json::to_string(&BTreeMap::from([(
            "cf",
            URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        )]))
        .unwrap();
        let pin: String = Sha256::digest(public.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let mut guard = guard();
        guard.trust = StorageTrust::parse(&public, &pin).unwrap();
        let claims = serde_json::json!({"v":1,"kid":"cf","database_id":"abcdefghijklmnopqrst","generation":1,"authority_revision":1,"storage_uid":"11111111-1111-4111-8111-111111111111","node_uid":guard.node_uid,"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","profile_sha256":"a".repeat(64),"volume_handle":"pvc-33333333-3333-4333-8333-333333333333","lv_uuid":"cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh","pvc_uid":"33333333-3333-4333-8333-333333333333","pv_uid":"44444444-4444-4444-8444-444444444444","pod_uid":"55555555-5555-4555-8555-555555555555","observed_at":1000,"iat":1000,"exp":11000,"guard_seconds":10,"drain_seconds":10,"write_allowed":true});
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signed = pair.sign(
            format!(
                "{}{}",
                pgcf_native_protocol::wire("storageAuthorityDomain"),
                body
            )
            .as_bytes(),
        );
        let token = format!(
            "{}.{}.{}",
            pgcf_native_protocol::wire("storageAuthorityPrefix"),
            body,
            URL_SAFE_NO_PAD.encode(signed.as_ref())
        );
        let mut initial = lease();
        initial.databases[0].authority_revision = 1;
        initial.databases[0].startup_expires_at = None;
        initial.databases[0].startup_operation_id = None;
        initial.databases[0].runtime_authority = Some(token);
        let mut volume = claims.clone();
        let object = volume.as_object_mut().unwrap();
        object.retain(|k, _| {
            [
                "node_uid",
                "volume_group_uuid",
                "pool_uuid",
                "storage_uid",
                "volume_handle",
                "lv_uuid",
                "pvc_uid",
                "pv_uid",
            ]
            .contains(&k.as_str())
        });
        object.insert("storage_generation".into(), 1.into());
        object.insert(
            "namespace_uid".into(),
            "66666666-6666-4666-8666-666666666666".into(),
        );
        object.insert(
            "cluster_uid".into(),
            "77777777-7777-4777-8777-777777777777".into(),
        );
        initial.databases[0].volume = Some(volume);
        assert!(
            guard
                .trust
                .verify(
                    initial.databases[0].runtime_authority.as_ref().unwrap(),
                    1000
                )
                .is_ok()
        );
        let shape =
            jsonschema::validator_for(&pgcf_native_protocol::CONTRACT["storageHostLease"]).unwrap();
        let raw = serde_json::to_value(&initial).unwrap();
        assert!(
            shape.is_valid(&raw),
            "{:?}",
            shape
                .iter_errors(&raw)
                .map(|e| e.instance_path().to_string())
                .collect::<Vec<_>>()
        );
        let historical = initial.databases[0].runtime_authority.clone().unwrap();
        let frozen_volume = initial.databases[0].volume.clone();
        guard.accept(initial.clone(), 1000).unwrap();
        let namespace = "pgcf-db-abcdefghijklmnopqrst";
        let pod = "55555555-5555-4555-8555-555555555555";
        assert!(guard.resume_scope(namespace, pod, 12000).is_none());
        let mut recovery = initial;
        recovery.issued_at = 12000;
        recovery.expires_at = 22000;
        let entry = &mut recovery.databases[0];
        entry.generation = 2;
        entry.runtime_authority = None;
        entry.startup_expires_at = Some(22000);
        entry.startup_operation_id = Some("op_abcdefghijklmnopqrs1".into());
        guard.accept(recovery, 12000).unwrap();
        assert!(!guard.permits_create(namespace, "replacement", 12000));
        let mut scope = guard.resume_scope(namespace, pod, 12000).unwrap();
        assert!(scope.current(12000));
        assert_eq!(scope.authority.claims().generation, 1);
        scope.deadline = Instant::now();
        assert!(!scope.current(12000));
        assert!(guard.resume_scope(namespace, pod, 22000).is_none());
        guard
            .entries
            .get_mut("abcdefghijklmnopqrst")
            .unwrap()
            .entry
            .volume
            .as_mut()
            .unwrap()["lv_uuid"] = "defghi-defg-defg-defg-defg-defg-defghi".into();
        assert!(guard.resume_scope(namespace, pod, 12000).is_none());
        guard
            .entries
            .get_mut("abcdefghijklmnopqrst")
            .unwrap()
            .entry
            .volume
            .as_mut()
            .unwrap()["lv_uuid"] = "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh".into();
        assert_eq!(
            guard.protective_pods(),
            vec![(pod.to_string(), namespace.to_string())]
        );
        guard.note_stopped(pod);
        assert!(!guard.permits_create(namespace, "replacement", 12000));
        guard.note_quiesced(pod);
        assert!(!guard.permits_create(namespace, "replacement", 12000));
        assert!(guard.resume_scope(namespace, pod, 12000).is_some());
        guard.note_resumed(pod, "op_abcdefghijklmnopqrs1", false);
        assert!(guard.permits_create(namespace, "replacement", 12000));
        assert!(guard.resume_scope(namespace, pod, 12000).is_none());
        let mut next_claims = claims.clone();
        for (key, value) in [
            ("generation", 2u64),
            ("authority_revision", 2),
            ("observed_at", 15000),
            ("iat", 15000),
            ("exp", 25000),
        ] {
            next_claims[key] = value.into();
        }
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&next_claims).unwrap());
        let signature = pair.sign(
            format!(
                "{}{}",
                pgcf_native_protocol::wire("storageAuthorityDomain"),
                body
            )
            .as_bytes(),
        );
        let token = format!(
            "{}.{}.{}",
            pgcf_native_protocol::wire("storageAuthorityPrefix"),
            body,
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );
        let mut next = lease();
        next.issued_at = 15000;
        next.expires_at = 25000;
        let entry = &mut next.databases[0];
        entry.generation = 2;
        entry.authority_revision = 2;
        entry.startup_expires_at = None;
        entry.startup_operation_id = None;
        entry.runtime_authority = Some(token);
        entry.volume = frozen_volume.clone();
        guard.accept(next.clone(), 15000).unwrap();
        assert!(!guard.stopped.contains(pod));
        assert!(!guard.quiesced.contains(pod));
        assert!(!guard.resumed.contains_key(pod));
        assert!(guard.permits(namespace, pod, 15000));
        assert!(!guard.permits(namespace, pod, 25000));
        guard.note_stopped(pod);
        guard.note_quiesced(pod);
        next.issued_at = 16000;
        next.expires_at = 26000;
        guard.accept(next, 16000).unwrap();
        assert!(guard.stopped.contains(pod) && guard.quiesced.contains(pod));
        let mut stop = lease();
        stop.issued_at = 17000;
        stop.expires_at = 27000;
        let e = &mut stop.databases[0];
        e.generation = 3;
        e.authority_revision = 3;
        e.desired_state = "suspended".into();
        e.write_blocked = true;
        e.startup_expires_at = None;
        e.startup_operation_id = None;
        e.runtime_authority = None;
        e.volume = frozen_volume.clone();
        e.drain = Some(Drain {
            operation_id: "op_abcdefghijklmnopqrs2".into(),
            kind: "database.suspend".into(),
            generation: 3,
            authority_revision: 3,
            expires_at: 27000,
            budget_bytes: 5368709120,
        });
        guard.accept(stop.clone(), 17000).unwrap();
        assert!(!guard.permits(namespace, pod, 17000));
        assert!(!guard.permits_create(namespace, "replacement", 17000));
        let scope = guard.resume_scope(namespace, pod, 17000).unwrap();
        assert!(scope.drain_only);
        assert_eq!(
            scope.operation_id.as_deref(),
            Some("op_abcdefghijklmnopqrs2")
        );
        guard.note_resumed(pod, "op_abcdefghijklmnopqrs2", true);
        guard.note_stopped(pod);
        assert!(guard.active_drain(namespace, pod, 17000));
        assert!(!guard.permits_create(namespace, "replacement", 17000));
        assert!(guard.resume_scope(namespace, pod, 17000).is_none());
        assert!(!guard.active_drain(namespace, pod, 27000));
        let mut invalid_stop = stop.clone();
        invalid_stop.issued_at = 18000;
        invalid_stop.expires_at = 28000;
        invalid_stop.databases[0].drain.as_mut().unwrap().kind = "database.delete".into();
        assert!(guard.accept(invalid_stop, 18000).is_err());
        let mut revoked = stop.clone();
        revoked.issued_at = 19000;
        revoked.expires_at = 29000;
        revoked.databases[0].drain = None;
        guard.accept(revoked, 19000).unwrap();
        assert!(!guard.active_drain(namespace, pod, 19000));
        assert!(guard.protection(namespace, pod).is_some());
        let mut changed = stop;
        changed.issued_at = 20000;
        changed.expires_at = 30000;
        changed.databases[0].volume.as_mut().unwrap()["lv_uuid"] =
            "defghi-defg-defg-defg-defg-defg-defghi".into();
        guard.accept(changed, 20000).unwrap();
        assert!(guard.resume_scope(namespace, pod, 20000).is_none());
        // Normal Stop/Remove plus restart keeps the expired signature solely as a physical barrier.
        let mut restarted = Guard::new(
            StorageAuthorityTrust {
                keys: serde_json::from_str(&public).unwrap(),
                sha256: pin.clone(),
                legacy_database_ids: vec![],
            },
            guard.node_uid.clone(),
            1,
        )
        .unwrap();
        restarted.retain_protective(pod, &historical).unwrap();
        restarted.note_stopped(pod);
        assert_eq!(
            restarted.protective_pods(),
            vec![(pod.to_string(), namespace.to_string())]
        );
        assert!(!restarted.permits_create(namespace, "replacement", 12000));
        assert!(restarted.resume_scope(namespace, pod, 12000).is_none());
        let mut deletion = lease();
        deletion.issued_at = 13000;
        deletion.expires_at = 23000;
        let entry = &mut deletion.databases[0];
        entry.generation = 2;
        entry.authority_revision = 2;
        entry.desired_state = "deleted".into();
        entry.write_blocked = false;
        entry.startup_expires_at = None;
        entry.startup_operation_id = None;
        entry.volume = None;
        restarted.accept(deletion.clone(), 13000).unwrap();
        assert!(restarted.retirement_scope(namespace, pod, 13000).is_some());
        assert!(restarted.retirement_scope(namespace, pod, 23000).is_none());
        restarted.rebind_material_revision(2, &[]).unwrap();
        assert!(restarted.retirement_scope(namespace, pod, 13000).is_none());
        deletion.material_revision = 2;
        deletion.issued_at = 14000;
        deletion.expires_at = 24000;
        deletion.databases[0].volume = frozen_volume;
        restarted.accept(deletion.clone(), 14000).unwrap();
        assert!(restarted.retirement_scope(namespace, pod, 14000).is_none());
        deletion.issued_at = 15000;
        deletion.expires_at = 25000;
        deletion.databases.clear();
        restarted.accept(deletion, 15000).unwrap();
        assert!(restarted.retirement_scope(namespace, pod, 15000).is_none());
        assert_eq!(restarted.protective_pods().len(), 1);
    }
    #[test]
    fn sealed_thick_cohort_is_available_before_any_network_result() {
        let keys = BTreeMap::from([(
            "cf".to_owned(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        )]);
        let sha256: String = Sha256::digest(serde_json::to_vec(&keys).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let config = StorageAuthorityTrust {
            keys,
            sha256,
            legacy_database_ids: vec!["abcdefghijklmnopqrst".into()],
        };
        let guard = Guard::new(
            config.clone(),
            "22222222-2222-4222-8222-222222222222".into(),
            1,
        )
        .unwrap();
        assert!(guard.permits("pgcf-db-abcdefghijklmnopqrst", "pod", 1000));
        assert!(!guard.permits("pgcf-db-bcdefghijklmnopqrstu1", "pod", 1000));
        assert!(
            Guard::new(
                StorageAuthorityTrust {
                    legacy_database_ids: vec!["../invalid".into()],
                    ..config
                },
                "22222222-2222-4222-8222-222222222222".into(),
                1
            )
            .is_err()
        );
    }
    #[test]
    fn a_fetch_outage_or_wall_clock_rollback_cannot_extend_startup() {
        let mut guard = guard();
        guard.accept(lease(), 2000).unwrap();
        let accepted = guard.entries.values().next().unwrap();
        assert!(guard.permits_at(accepted, "pod", 2000, Duration::from_secs(8)));
        assert!(!guard.permits_at(accepted, "pod", 1000, Duration::from_secs(9)));
        assert!(!guard.permits_at(accepted, "pod", 11000, Duration::ZERO));
    }
    #[test]
    fn an_equal_authority_refresh_cannot_restart_the_monotonic_stop_clock() {
        let mut guard = guard();
        guard.accept(lease(), 2000).unwrap();
        guard
            .entries
            .get_mut("abcdefghijklmnopqrst")
            .unwrap()
            .remaining = Duration::from_millis(2);
        let mut repeated = lease();
        repeated.issued_at = 2000;
        guard.accept(repeated, 1000).unwrap();
        assert!(guard.entries["abcdefghijklmnopqrst"].remaining <= Duration::from_millis(2));
    }
    #[test]
    fn material_rebind_keeps_the_existing_deadline_until_new_authority() {
        let mut guard = guard();
        guard.accept(lease(), 2000).unwrap();
        let before = guard.entries.values().next().unwrap().remaining;
        guard.rebind_material_revision(2, &[]).unwrap();
        assert_eq!(guard.material_revision, 2);
        let accepted = guard.entries.values().next().unwrap();
        assert_eq!(accepted.remaining, before);
        assert!(guard.permits_at(accepted, "pod", 2500, Duration::ZERO));
        assert!(!guard.permits_at(accepted, "pod", 11000, Duration::ZERO));
        assert!(guard.rebind_material_revision(1, &[]).is_err());
        let mut updated = lease();
        updated.material_revision = 2;
        guard.accept(updated, 2000).unwrap();
        assert!(guard.entries.values().next().unwrap().remaining <= before);
    }
    #[test]
    fn missing_changed_or_duplicate_assignments_are_closed() {
        let mut guard = guard();
        assert!(!guard.permits("pgcf-db-abcdefghijklmnopqrst", "pod", 1000));
        let mut changed = lease();
        changed.node_uid = "33333333-3333-4333-8333-333333333333".into();
        assert!(guard.accept(changed, 1000).is_err());
        let mut duplicate = lease();
        duplicate.databases.push(duplicate.databases[0].clone());
        assert!(guard.accept(duplicate, 1000).is_err());
        guard.accept(lease(), 1000).unwrap();
        let mut old = lease();
        old.issued_at = 999;
        assert!(guard.accept(old, 1000).is_err());
    }
    #[test]
    fn only_cf_proven_bound_thick_ids_survive_a_refresh_outage() {
        let mut guard = guard();
        let mut value = lease();
        value.databases.clear();
        value.legacy.push(Legacy {
            database_id: "abcdefghijklmnopqrst".into(),
            generation: 1,
            namespace: "pgcf-db-abcdefghijklmnopqrst".into(),
        });
        guard.accept(value, 1000).unwrap();
        assert!(guard.permits("pgcf-db-abcdefghijklmnopqrst", "pod", 999999));
        assert!(!guard.permits("pgcf-db-bcdefghijklmnopqrstu1", "pod", 999999));
    }
}
