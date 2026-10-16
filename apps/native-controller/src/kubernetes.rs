// SPDX-License-Identifier: Apache-2.0
use crate::{Error, contracts::text};
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::{Client, Method, StatusCode, Url};
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fmt,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
#[derive(Debug)]
struct KubeletVerifier {
    inner: Arc<rustls::client::WebPkiServerVerifier>,
    leaf: Vec<u8>,
    name: String,
}
impl rustls::client::danger::ServerCertVerifier for KubeletVerifier {
    fn verify_server_cert(
        &self,
        end: &rustls::pki_types::CertificateDer<'_>,
        chain: &[rustls::pki_types::CertificateDer<'_>],
        name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if end.as_ref() != self.leaf {
            return Err(rustls::Error::General("kubelet leaf pin changed".into()));
        }
        let (_, cert) = x509_parser::parse_x509_certificate(end.as_ref())
            .map_err(|_| rustls::Error::General("kubelet certificate invalid".into()))?;
        let exact=cert.subject_alternative_name().map_err(|_|rustls::Error::General("kubelet SAN invalid".into()))?.is_some_and(|san|san.value.general_names.iter().any(|n|matches!(n,x509_parser::extensions::GeneralName::DNSName(n) if *n==self.name)));
        if !exact {
            return Err(rustls::Error::General("kubelet identity mismatch".into()));
        }
        self.inner.verify_server_cert(end, chain, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[derive(Debug)]
pub struct KubernetesError {
    pub status: u16,
}
impl fmt::Display for KubernetesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Kubernetes HTTP{}", self.status)
    }
}
impl std::error::Error for KubernetesError {}
#[derive(Clone)]
pub struct Kubernetes {
    client: Client,
    origin: Url,
    token: PathBuf,
    continuity: Arc<Mutex<WatchContinuity>>,
}
pub const RUNTIME_WATCH_KINDS: [&str; 8] = [
    "Namespace",
    "Node",
    "PersistentVolume",
    "Pod",
    "Cluster",
    "PersistentVolumeClaim",
    "Secret",
    "ConfigMap",
];
/// The kinds the wake of a parked database proves unchanged without reading them: the manifests
/// it applies that the runtime watches above do not cover, and the volume of the claim. Their
/// watches only keep track of versions; no change of them hints a database, as none did before.
pub const PLAN_WATCH_KINDS: [&str; 7] = [
    "ResourceQuota",
    "LimitRange",
    "NetworkPolicy",
    "CiliumNetworkPolicy",
    "ObjectStore",
    "ScheduledBackup",
    "LVMVolume",
];
/// Whether a metadata watch follows `kind`.
fn watched(kind: &str) -> bool {
    RUNTIME_WATCH_KINDS.contains(&kind) || PLAN_WATCH_KINDS.contains(&kind)
}
/// How many objects the memory of reads holds before it drops those the watch no longer vouches
/// for: a database is about twenty of them, and an object is a few kilobytes, so the bound on what
/// the controller keeps of the cluster is some tens of MiB of the 384 it may use.
const REMEMBERED_MAX: usize = 8_192;
/// How many objects one page of a watch baseline holds: a page of metadata stays far below the
/// bound a response is read with, whatever the annotations of the objects weigh.
const BASELINE_PAGE: usize = 100;
/// How many objects the watches of all kinds keep track of together; each takes a few hundred
/// bytes. A cluster with more is not one the controller can prove anything about.
const MAX_TRACKED_OBJECTS: usize = 65_536;
/// How long the version of this controller's own write is remembered for the event of the watch
/// that is still to come; a watch that restarted past it never delivers it.
const OWN_WRITE_MEMORY: Duration = Duration::from_secs(120);
/// How long a change of an object that is not known to be this controller's own is held back
/// before it hints: the API server tells its watches of a write about as it answers the writer, and
/// which of the two reaches this controller first is not up to it. An event that comes first names
/// a version that is only known to be the controller's own once the answer has been read.
const OWN_WRITE_SETTLE: Duration = Duration::from_millis(25);
/// How many reads of one group are in flight at once: the group of a pass is a dozen objects and
/// the API server answers each in a few milliseconds.
const READ_FANOUT: usize = 8;
/// Versions remembered for one object: a pass writes one object a few times at most.
const OWN_WRITES_PER_OBJECT: usize = 16;
/// What a metadata watch hints: the database whose object changed, and the object's name. The
/// name is for the log that says what made a database due; it never reaches a decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trigger {
    /// Empty for an object of a free pool slot.
    pub database: String,
    pub name: String,
    /// The pool slot whose object changed: the hex of its `pgcf-slot-<hex>` namespace.
    pub slot: Option<String>,
}
/// What the watch holds of one object: its identity and version, and the shape of the rest of
/// its metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Tracked {
    uid: String,
    version: String,
    /// A digest of what a write of an object's status leaves as it is: its generation, labels,
    /// annotations, finalizers, owners and deletion mark.
    shape: [u8; 32],
}
fn shape(metadata: &Value) -> [u8; 32] {
    let shape = json!([
        metadata["generation"],
        metadata["labels"],
        metadata["annotations"],
        metadata["finalizers"],
        metadata["ownerReferences"],
        metadata["deletionTimestamp"]
    ]);
    Sha256::digest(shape.to_string().as_bytes()).into()
}
/// A change that hints a database unless the version it names turns out to be one this
/// controller wrote itself, once the answers of its writes in flight are in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) trigger: Trigger,
    kind: String,
    namespace: String,
    version: String,
}
#[derive(Debug)]
struct WatchContinuity {
    controller_epoch: String,
    epoch: u64,
    kinds: HashMap<String, (String, Instant, bool)>,
    objects: HashMap<(String, String, String), Tracked>,
    /// Versions of watched objects that this controller itself wrote and whose watch events have
    /// not arrived yet, by (kind, namespace, name): the pass that wrote one holds the object as
    /// written, so its event is not a change someone else made.
    written: HashMap<(String, String, String), Vec<(String, Instant)>>,
    /// How long a change is held back before it hints (`OWN_WRITE_SETTLE`).
    settle: Duration,
    /// What the controller last read or wrote of an object, as it was found.
    remembered: HashMap<(String, String, String), Remembered>,
    /// The database each claimed pool slot namespace serves (pool design 2026-10-16).
    slots: HashMap<String, String>,
    /// A test that pins how reads are made when the watch cannot vouch for what was read turns
    /// the memory off.
    #[cfg(test)]
    recalling: bool,
}
/// What a read of an object found. The watch says whether that is still the object's state: the
/// object is the version it was read at, or it was not there and the watch still holds none.
#[derive(Debug)]
enum Remembered {
    Absent,
    Present(Value),
}
impl Default for WatchContinuity {
    fn default() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let material = format!(
            "{}:{}:{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        Self {
            controller_epoch: Sha256::digest(material.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            epoch: 1,
            kinds: HashMap::new(),
            objects: HashMap::new(),
            written: HashMap::new(),
            settle: OWN_WRITE_SETTLE,
            remembered: HashMap::new(),
            slots: HashMap::new(),
            #[cfg(test)]
            recalling: true,
        }
    }
}
impl WatchContinuity {
    /// Whether the watch of `kind` is established and has been heard from lately.
    fn watching(&self, kind: &str) -> bool {
        self.kinds
            .get(kind)
            .is_some_and(|(_, at, live)| *live && at.elapsed() < Duration::from_secs(70))
    }
    /// The state of an object as the last read or write of it found it, if the watch proves that
    /// nothing has changed it since: the watch holds it at that very version, or holds none of it
    /// as it did not when it was found absent. `None` when nothing can be said. The watch trails
    /// the API server by the time an event takes, the lag every read of a cache has too.
    fn recall(&self, kind: &str, namespace: &str, name: &str) -> Option<Option<Value>> {
        #[cfg(test)]
        if !self.recalling {
            return None;
        }
        if !self.watching(kind) {
            return None;
        }
        let key = (kind.to_string(), namespace.to_string(), name.to_string());
        match (self.remembered.get(&key)?, self.objects.get(&key)) {
            (Remembered::Absent, None) => Some(None),
            (Remembered::Present(object), Some(held))
                if text(&object["metadata"], "uid") == held.uid
                    && text(&object["metadata"], "resourceVersion") == held.version =>
            {
                Some(Some(object.clone()))
            }
            _ => None,
        }
    }
    /// Keeps what a read or a write of an object found, `None` for an object that was not there.
    fn remember(&mut self, kind: &str, namespace: &str, name: &str, found: Option<&Value>) {
        if !watched(kind) {
            return;
        }
        let entry = match found {
            None => Remembered::Absent,
            Some(object)
                if !text(&object["metadata"], "uid").is_empty()
                    && !text(&object["metadata"], "resourceVersion").is_empty() =>
            {
                Remembered::Present(object.clone())
            }
            Some(_) => return,
        };
        if self.remembered.len() >= REMEMBERED_MAX {
            let objects = &self.objects;
            self.remembered
                .retain(|key, entry| match (entry, objects.get(key)) {
                    (Remembered::Absent, None) => true,
                    (Remembered::Present(object), Some(held)) => {
                        text(&object["metadata"], "resourceVersion") == held.version
                    }
                    _ => false,
                });
            if self.remembered.len() >= REMEMBERED_MAX {
                self.remembered.clear();
            }
        }
        self.remembered.insert(
            (kind.to_string(), namespace.to_string(), name.to_string()),
            entry,
        );
    }
    /// Records which database a slot namespace serves, `None` for none.
    fn index_slot(&mut self, namespace: &str, database: Option<&str>) {
        match database {
            Some(database) => {
                self.slots.insert(namespace.into(), database.into());
            }
            None => {
                self.slots.remove(namespace);
            }
        }
    }
    fn connected(&mut self, kind: &str, version: &str) {
        self.kinds
            .insert(kind.into(), (version.into(), Instant::now(), true));
    }
    fn observe(&mut self, kind: &str, object: &Value, deleted: bool) -> bool {
        let metadata = &object["metadata"];
        let name = text(metadata, "name");
        let uid = text(metadata, "uid");
        let rv = text(metadata, "resourceVersion");
        if name.is_empty()
            || name.len() > 253
            || uid.is_empty()
            || uid.len() > 128
            || rv.is_empty()
            || rv.len() > 128
        {
            return false;
        }
        let key = (kind.into(), text(metadata, "namespace").into(), name.into());
        if deleted {
            self.objects.remove(&key);
            self.remembered.remove(&key);
        } else {
            if self.objects.len() >= MAX_TRACKED_OBJECTS && !self.objects.contains_key(&key) {
                return false;
            }
            self.objects.insert(
                key,
                Tracked {
                    uid: uid.into(),
                    version: rv.into(),
                    shape: shape(metadata),
                },
            );
        }
        true
    }
    fn resource_current(&self, kind: &str, resource: &Value) -> bool {
        let meta = &resource["metadata"];
        let key = (
            kind.into(),
            text(meta, "namespace").into(),
            text(meta, "name").into(),
        );
        self.watching(kind)
            && self.objects.get(&key).is_some_and(|held| {
                Some(held.uid.as_str()) == meta["uid"].as_str()
                    && Some(held.version.as_str()) == meta["resourceVersion"].as_str()
            })
    }
    fn gap(&mut self, kind: &str) {
        // The epoch is the runtime proof's: a kind that is no part of it is no gap of it.
        if RUNTIME_WATCH_KINDS.contains(&kind) {
            self.epoch += 1;
        }
        self.kinds.remove(kind);
        self.objects.retain(|(resource, _, _), _| resource != kind);
        self.remembered
            .retain(|(resource, _, _), _| resource != kind);
    }
    fn snapshot(&self) -> Option<(String, u64)> {
        RUNTIME_WATCH_KINDS
            .iter()
            .all(|kind| self.watching(kind))
            .then(|| (self.controller_epoch.clone(), self.epoch))
    }
    /// The kinds the runtime proof needs a current watch of that have none.
    fn unwatched(&self) -> Vec<&'static str> {
        RUNTIME_WATCH_KINDS
            .into_iter()
            .filter(|kind| !self.watching(kind))
            .collect()
    }
    /// Remembers that this controller wrote `object`, as the write answered, over the version
    /// `before`. A write that changed nothing answers the version it was made over and leaves no
    /// event, so none is expected for it.
    fn wrote(&mut self, kind: &str, object: &Value, before: &str) {
        let meta = &object["metadata"];
        let version = text(meta, "resourceVersion");
        if !RUNTIME_WATCH_KINDS.contains(&kind)
            || version.is_empty()
            || version.len() > 128
            || version == before
        {
            return;
        }
        let key = (
            kind.to_string(),
            text(meta, "namespace").to_string(),
            text(meta, "name").to_string(),
        );
        let versions = self.written.entry(key).or_default();
        versions.retain(|(_, at)| at.elapsed() < OWN_WRITE_MEMORY);
        if versions.len() >= OWN_WRITES_PER_OBJECT {
            versions.remove(0);
        }
        versions.push((version.to_string(), Instant::now()));
        if self.written.len() > 4096 {
            self.written.retain(|_, versions| {
                versions.retain(|(_, at)| at.elapsed() < OWN_WRITE_MEMORY);
                !versions.is_empty()
            });
        }
    }
    /// Whether `object` is a version this controller wrote itself; its event ends the memory of it.
    fn own(&mut self, kind: &str, object: &Value) -> bool {
        let meta = &object["metadata"];
        self.own_version(
            kind,
            text(meta, "namespace"),
            text(meta, "name"),
            text(meta, "resourceVersion"),
        )
    }
    fn own_version(&mut self, kind: &str, namespace: &str, name: &str, version: &str) -> bool {
        let key = (kind.to_string(), namespace.to_string(), name.to_string());
        let Some(versions) = self.written.get_mut(&key) else {
            return false;
        };
        let Some(at) = versions.iter().position(|(held, _)| held == version) else {
            return false;
        };
        versions.remove(at);
        if versions.is_empty() {
            self.written.remove(&key);
        }
        true
    }
    /// One event of a metadata watch of `kind`: the revision the watch stands at afterwards and
    /// the database it hints for reconciliation. The event of a version this controller wrote
    /// itself hints no database: the pass that wrote it holds the object as written, and a change
    /// someone else makes has a version of its own.
    fn event(&mut self, kind: &str, event: &Value) -> Result<(String, Option<Candidate>), Error> {
        let event_type = text(event, "type");
        if event_type == "ERROR" {
            return Err("Kubernetes watch history gap".into());
        }
        if !["ADDED", "MODIFIED", "DELETED", "BOOKMARK"].contains(&event_type) {
            return Err("Kubernetes watch event invalid".into());
        }
        let object = &event["object"];
        let version = text(&object["metadata"], "resourceVersion");
        if version.is_empty() || version.len() > 128 {
            return Err("Kubernetes watch revision missing".into());
        }
        self.connected(kind, version);
        if event_type == "BOOKMARK" {
            return Ok((version.to_string(), None));
        }
        let meta = &object["metadata"];
        let key = (
            kind.to_string(),
            text(meta, "namespace").to_string(),
            text(meta, "name").to_string(),
        );
        // A write that only moved the status of the object leaves the rest of its metadata as it
        // was held; an object the watch did not hold, or held as another, is news.
        let status_only = event_type == "MODIFIED"
            && self
                .objects
                .get(&key)
                .is_some_and(|held| held.uid == text(meta, "uid") && held.shape == shape(meta));
        if !self.observe(kind, object, event_type == "DELETED") {
            return Err("watch object metadata invalid".into());
        }
        if !RUNTIME_WATCH_KINDS.contains(&kind) {
            return Ok((version.to_string(), None));
        }
        let labelled = text(&meta["labels"], "pgcf.io/database-id");
        // An object of a pool slot names its slot, and the database while one is claimed.
        let home = if kind == "Namespace" {
            text(meta, "name")
        } else {
            text(meta, "namespace")
        };
        let slot = pgcf_native_protocol::wake::is_slot_namespace(home)
            .then(|| home[pgcf_native_protocol::wake::SLOT_NAMESPACE_PREFIX.len()..].to_string());
        let served = slot
            .as_ref()
            .and_then(|_| self.slots.get(home))
            .cloned()
            .unwrap_or_default();
        let id = if !labelled.is_empty() {
            labelled
        } else if slot.is_some() {
            served.as_str()
        } else {
            text(meta, "namespace")
                .strip_prefix("pgcf-db-")
                .unwrap_or("")
        };
        // The records of pgcf-system are written by this controller alone, the sampler's ledger
        // every two seconds among them: a change of one is its own, and a deleted one is news.
        // The status of a Cluster is CNPG's: its Pod, its Secrets and its annotations say what a
        // pass decides on. A Pod's status is not set apart like that, it is read.
        let own_record = kind == "ConfigMap"
            && text(meta, "namespace") == "pgcf-system"
            && event_type != "DELETED";
        let status_of_cnpg = kind == "Cluster" && status_only;
        let hint = ((pgcf_native_protocol::valid_pattern("database", id) || slot.is_some())
            && !own_record
            && !status_of_cnpg
            && !self.own(kind, object))
        .then(|| Candidate {
            trigger: Trigger {
                database: if pgcf_native_protocol::valid_pattern("database", id) {
                    id.to_string()
                } else {
                    String::new()
                },
                name: text(meta, "name").to_string(),
                slot: slot.clone(),
            },
            kind: kind.to_string(),
            namespace: text(meta, "namespace").to_string(),
            version: version.to_string(),
        });
        Ok((version.to_string(), hint))
    }
}
struct WatchGuard {
    state: Arc<Mutex<WatchContinuity>>,
    kind: String,
}
impl Drop for WatchGuard {
    fn drop(&mut self) {
        self.state.lock().unwrap().gap(&self.kind);
    }
}
/// Whether `value` is a Kubernetes object name this client will put in a path.
pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn resource(kind: &str) -> Result<(&'static str, &'static str, bool), Error> {
    Ok(match kind {
        "Namespace" => ("/api/v1", "namespaces", true),
        "Node" => ("/api/v1", "nodes", true),
        "PersistentVolume" => ("/api/v1", "persistentvolumes", true),
        "RuntimeClass" => ("/apis/node.k8s.io/v1", "runtimeclasses", true),
        "MutatingAdmissionPolicy" => (
            "/apis/admissionregistration.k8s.io/v1",
            "mutatingadmissionpolicies",
            true,
        ),
        "MutatingAdmissionPolicyBinding" => (
            "/apis/admissionregistration.k8s.io/v1",
            "mutatingadmissionpolicybindings",
            true,
        ),
        "Pod" => ("/api/v1", "pods", false),
        "Secret" => ("/api/v1", "secrets", false),
        "ConfigMap" => ("/api/v1", "configmaps", false),
        "ResourceQuota" => ("/api/v1", "resourcequotas", false),
        "LimitRange" => ("/api/v1", "limitranges", false),
        "PersistentVolumeClaim" => ("/api/v1", "persistentvolumeclaims", false),
        "Cluster" => ("/apis/postgresql.cnpg.io/v1", "clusters", false),
        "ScheduledBackup" => ("/apis/postgresql.cnpg.io/v1", "scheduledbackups", false),
        "Backup" => ("/apis/postgresql.cnpg.io/v1", "backups", false),
        "ObjectStore" => ("/apis/barmancloud.cnpg.io/v1", "objectstores", false),
        "LVMVolume" => ("/apis/local.openebs.io/v1alpha1", "lvmvolumes", false),
        "LVMNode" => ("/apis/local.openebs.io/v1alpha1", "lvmnodes", false),
        "NetworkPolicy" => ("/apis/networking.k8s.io/v1", "networkpolicies", false),
        "CiliumNetworkPolicy" => ("/apis/cilium.io/v2", "ciliumnetworkpolicies", false),
        "DaemonSet" => ("/apis/apps/v1", "daemonsets", false),
        "HelmRelease" => ("/apis/helm.toolkit.fluxcd.io/v2", "helmreleases", false),
        "OCIRepository" => (
            "/apis/source.toolkit.fluxcd.io/v1",
            "ocirepositories",
            false,
        ),
        "HelmChart" => ("/apis/source.toolkit.fluxcd.io/v1", "helmcharts", false),
        "GitRepository" => (
            "/apis/source.toolkit.fluxcd.io/v1",
            "gitrepositories",
            false,
        ),
        "Kustomization" => (
            "/apis/kustomize.toolkit.fluxcd.io/v1",
            "kustomizations",
            false,
        ),
        "Job" => ("/apis/batch/v1", "jobs", false),
        _ => return Err("unsupported Kubernetes resource".into()),
    })
}
fn collection(kind: &str, namespace: Option<&str>) -> Result<String, Error> {
    let (prefix, plural, cluster) = resource(kind)?;
    if cluster && namespace.is_some() {
        return Err("invalid Kubernetes namespace scope".into());
    }
    if let Some(ns) = namespace {
        if !identifier(ns) {
            return Err("invalid Kubernetes namespace".into());
        }
        Ok(format!("{prefix}/namespaces/{ns}/{plural}"))
    } else {
        Ok(format!("{prefix}/{plural}"))
    }
}
pub(crate) fn named(kind: &str, namespace: Option<&str>, name: &str) -> Result<String, Error> {
    if !identifier(name) {
        return Err("invalid Kubernetes resource name".into());
    }
    if namespace.is_none() && !resource(kind)?.2 {
        return Err("namespaced Kubernetes read requires namespace".into());
    }
    Ok(format!("{}/{name}", collection(kind, namespace)?))
}
/// Kubernetes never restarts a Succeeded or Failed Pod; a deletionTimestamp alone proves no stop.
pub fn terminal_pod(pod: &Value) -> bool {
    matches!(text(&pod["status"], "phase"), "Succeeded" | "Failed")
}
pub async fn bounded(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|v| v > maximum as u64)
    {
        return Err("HTTP response exceeds bound".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part?;
        if part.len() > maximum - bytes.len() {
            return Err("HTTP response exceeds bound".into());
        }
        bytes.extend_from_slice(&part);
    }
    Ok(bytes)
}
/// Whether `value` is the object of `kind`, `namespace` and `name` that was asked for.
fn is_object(value: &Value, kind: &str, namespace: Option<&str>, name: &str) -> bool {
    text(value, "kind") == kind
        && text(&value["metadata"], "name") == name
        && namespace.is_none_or(|ns| text(&value["metadata"], "namespace") == ns)
}
impl Kubernetes {
    /// Records which database the slot namespace `namespace` serves (`None`: none), so that a
    /// change of its objects hints that database.
    pub fn index_slot(&self, namespace: &str, database: Option<&str>) {
        self.continuity
            .lock()
            .unwrap()
            .index_slot(namespace, database);
    }
    pub fn runtime_continuity(&self) -> Option<(String, u64)> {
        self.continuity.lock().unwrap().snapshot()
    }
    /// The kinds without a current watch, which keep a parked wake from being published on the barrier.
    pub fn runtime_unwatched(&self) -> Vec<&'static str> {
        self.continuity.lock().unwrap().unwatched()
    }
    /// What one event of a metadata watch of `kind` makes of the watch: the revision it stands at
    /// and the database it hints. An event for a version this controller wrote itself hints no
    /// database.
    pub(crate) fn watch_event(
        &self,
        kind: &str,
        event: &Value,
    ) -> Result<(String, Option<Candidate>), Error> {
        self.continuity.lock().unwrap().event(kind, event)
    }
    /// Whether `candidate` still hints its database: not once the answer of the write it belongs to
    /// has been read and its version is known to be this controller's own.
    pub(crate) fn still_a_hint(&self, candidate: &Candidate) -> bool {
        !self.continuity.lock().unwrap().own_version(
            &candidate.kind,
            &candidate.namespace,
            &candidate.trigger.name,
            &candidate.version,
        )
    }
    /// The watch of `kind` ends, as one that was cut off does.
    #[cfg(test)]
    pub(crate) fn watch_ends(&self, kind: &str) {
        self.continuity.lock().unwrap().gap(kind);
    }
    /// From now on no read is answered from memory: every read is made, as when the watch cannot
    /// vouch for any object.
    #[cfg(test)]
    pub(crate) fn recall_nothing(&self) {
        self.continuity.lock().unwrap().recalling = false;
    }
    /// How long a change is held back before it hints, for a test that makes the answer of a write
    /// trail its event by a time of its own.
    #[cfg(test)]
    pub(crate) fn settle_within(&self, settle: Duration) {
        self.continuity.lock().unwrap().settle = settle;
    }
    pub fn runtime_resource_current(&self, resource: &Value) -> bool {
        self.continuity
            .lock()
            .unwrap()
            .resource_current(text(resource, "kind"), resource)
    }
    pub fn runtime_proof_current(&self, proof: &Value) -> bool {
        let state = self.continuity.lock().unwrap();
        let clock = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok());
        if clock.is_none_or(|now| {
            proof["observation"]["expires_at"]
                .as_u64()
                .is_none_or(|expiry| expiry <= now)
        }) {
            return false;
        }
        if state.snapshot().as_ref()
            != Some(&(
                text(&proof["observation"], "controller_epoch").into(),
                proof["observation"]["watch_epoch"].as_u64().unwrap_or(0),
            ))
        {
            return false;
        }
        [
            ("namespace", "Namespace", "namespace_uid"),
            ("cluster", "Cluster", "cnpg_cluster_uid"),
            ("pod", "Pod", "pod_uid"),
            ("ca_secret", "Secret", "ca_secret_uid"),
            ("storage", "ConfigMap", "storage_uid"),
            ("pvc", "PersistentVolumeClaim", "pvc_uid"),
            ("pv", "PersistentVolume", "pv_uid"),
            ("node", "Node", "node_uid"),
        ]
        .iter()
        .all(|(key, kind, uid)| {
            state.objects.iter().any(|((resource, _, _), held)| {
                resource == kind
                    && Some(held.uid.as_str()) == proof[*uid].as_str()
                    && Some(held.version.as_str())
                        == proof["observation"]["resource_versions"][*key].as_str()
            })
        })
    }
    /// The watch of an in-process test world: every runtime kind is live and the cache holds
    /// exactly `objects` at their current versions, as a watch without lag would.
    #[cfg(test)]
    pub(crate) fn mirror<'a>(&self, objects: impl IntoIterator<Item = &'a Value>) {
        let mut state = self.continuity.lock().unwrap();
        state.objects.clear();
        for kind in RUNTIME_WATCH_KINDS.into_iter().chain(PLAN_WATCH_KINDS) {
            state.connected(kind, "1");
        }
        for object in objects {
            if let Some(kind) = object["kind"].as_str().filter(|kind| watched(kind)) {
                state.observe(kind, object, false);
            }
        }
    }
    /// Waits for at most `within` until the watch holds `resource` at its version: a write of
    /// this controller is part of the world a runtime proof describes only once its own watch has
    /// delivered it. `false` means it has not within `within`.
    pub async fn observed(&self, resource: &Value, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            if self.runtime_resource_current(resource) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    pub async fn version(&self) -> Result<Value, Error> {
        self.request(Method::GET, "/version", None)
            .await?
            .ok_or_else(|| "Kubernetes version unavailable".into())
    }
    pub async fn stats_summary(&self, node: &str) -> Result<Value, Error> {
        if !identifier(node) {
            return Err("invalid kubelet node name".into());
        }
        let subject = self
            .read("Node", None, node)
            .await?
            .ok_or("kubelet node missing")?;
        let uid = text(&subject["metadata"], "uid");
        if uid.is_empty() || !subject["metadata"]["deletionTimestamp"].is_null() {
            return Err("kubelet node identity missing".into());
        }
        let cluster = self
            .read("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity missing")?;
        let trust = self
            .read("ConfigMap", Some("pgcf-system"), &format!("kubelet-{uid}"))
            .await?
            .ok_or("pinned kubelet trust is missing")?;
        if trust["metadata"]["labels"]["pgcf.io/kubelet-node-uid"] != uid
            || trust["data"]["node_uid"] != uid
            || trust["data"]["node_name"] != node
            || trust["data"]["cluster_uid"] != cluster["metadata"]["uid"]
            || !trust["metadata"]["deletionTimestamp"].is_null()
            || text(&trust["metadata"], "resourceVersion").is_empty()
        {
            return Err("pinned kubelet association changed".into());
        }
        let pem = text(&trust["data"], "certificate_pem");
        let digest = Sha256::digest(pem.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if pem.is_empty()
            || pem.len() > 16 * 1024
            || pem.contains("PRIVATE KEY")
            || text(&trust["data"], "certificate_sha256") != digest
        {
            return Err("pinned kubelet certificate changed".into());
        }
        let certs =
            CertificateDer::pem_slice_iter(pem.as_bytes()).collect::<Result<Vec<_>, _>>()?;
        if certs.is_empty() || certs.len() > 8 {
            return Err("kubelet certificate chain invalid".into());
        }
        let mut roots = rustls::RootCertStore::empty();
        for cert in &certs {
            let (_, parsed) = x509_parser::parse_x509_certificate(cert.as_ref())
                .map_err(|_| "kubelet certificate invalid")?;
            if !parsed.validity().is_valid() {
                return Err("kubelet certificate expired or future".into());
            }
            roots.add(cert.clone())?;
        }
        let verifier = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots)).build()?;
        let tls = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(KubeletVerifier {
                inner: verifier,
                leaf: certs[0].as_ref().to_vec(),
                name: node.to_string(),
            }))
            .with_no_client_auth();
        let addresses = subject["status"]["addresses"]
            .as_array()
            .ok_or("node addresses unavailable")?;
        let ips = addresses
            .iter()
            .filter(|a| text(a, "type") == "InternalIP")
            .map(|a| text(a, "address").parse::<IpAddr>())
            .collect::<Result<Vec<_>, _>>()?;
        if ips.is_empty()
            || ips.len() > 2
            || (ips.len() == 2 && ips[0].is_ipv4() == ips[1].is_ipv4())
        {
            return Err("kubelet internal address ambiguous".into());
        }
        let client = Client::builder()
            .use_preconfigured_tls(tls)
            .resolve(node, SocketAddr::new(ips[0], 10250))
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        let token = tokio::fs::read_to_string(&self.token).await?;
        let response = client
            .get(format!("https://{node}:10250/stats/summary"))
            .bearer_auth(token.trim())
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("kubelet stats unavailable".into());
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        let after = self
            .read("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity disappeared")?;
        if after["metadata"]["uid"] != cluster["metadata"]["uid"] {
            return Err("cluster identity changed during kubelet proof".into());
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub async fn watch_database_ids(
        &self,
        kind: &str,
        events: tokio::sync::mpsc::Sender<Trigger>,
    ) -> Result<(), Error> {
        if !watched(kind) {
            return Err("unsupported controller watch".into());
        }
        let _guard = WatchGuard {
            state: self.continuity.clone(),
            kind: kind.into(),
        };
        let path = collection(kind, None)?;
        let mut held: VecDeque<(Instant, Candidate)> = VecDeque::new();
        // The baseline is every object of the kind at one revision. The API server pages a list,
        // and every page of it answers that revision; the watch continues from it.
        let mut version = String::new();
        let mut next = String::new();
        loop {
            let mut url = self.origin.join(&path)?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("limit", &BASELINE_PAGE.to_string());
                if !next.is_empty() {
                    query.append_pair("continue", &next);
                }
            }
            let token = tokio::fs::read_to_string(&self.token).await?;
            let response = self
                .client
                .get(url)
                .bearer_auth(token.trim())
                .header(
                    "Accept",
                    "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1",
                )
                .send()
                .await?
                .error_for_status()?;
            let page: Value = serde_json::from_slice(&bounded(response, 2 * 1024 * 1024).await?)?;
            let revision = text(&page["metadata"], "resourceVersion");
            let items = page["items"]
                .as_array()
                .filter(|items| items.len() <= BASELINE_PAGE)
                .ok_or("watch baseline incomplete")?;
            if revision.is_empty()
                || revision.len() > 128
                || (!version.is_empty() && version != revision)
            {
                return Err("watch baseline incomplete or missing revision".into());
            }
            version = revision.to_string();
            for item in items {
                if !self.continuity.lock().unwrap().observe(kind, item, false) {
                    return Err("watch baseline metadata invalid".into());
                }
            }
            next = text(&page["metadata"], "continue").to_string();
            if next.is_empty() {
                break;
            }
            if next.len() > 4096 {
                return Err("watch baseline continuation invalid".into());
            }
        }
        loop {
            let mut url = self.origin.join(&path)?;
            url.query_pairs_mut()
                .append_pair("watch", "true")
                .append_pair("allowWatchBookmarks", "true")
                .append_pair("timeoutSeconds", "60")
                .append_pair("resourceVersion", &version);
            let token = tokio::fs::read_to_string(&self.token).await?;
            let response = tokio::time::timeout(
                Duration::from_secs(10),
                self.client
                    .get(url)
                    .header(
                        "Accept",
                        "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1",
                    )
                    .bearer_auth(token.trim())
                    .timeout(Duration::from_secs(65))
                    .send(),
            )
            .await??;
            if !response.status().is_success() {
                return Err(Box::new(KubernetesError {
                    status: response.status().as_u16(),
                }));
            }
            self.continuity.lock().unwrap().connected(kind, &version);
            let mut stream = response.bytes_stream();
            let mut frame = Vec::new();
            loop {
                // A change is held for the settle window and judged again at its end, when the
                // answer of the write it may belong to has been read.
                let release_at = held.front().map(|(at, _)| *at);
                let bytes = tokio::select! {
                    bytes = stream.next() => bytes,
                    () = async {
                        match release_at {
                            Some(at) => tokio::time::sleep_until(at.into()).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        self.release(&mut held, &events, false)?;
                        continue;
                    }
                };
                let Some(bytes) = bytes else {
                    break;
                };
                let bytes = bytes?;
                if bytes.len() > 1024 * 1024 - frame.len() {
                    return Err("Kubernetes watch frame exceeds bound".into());
                }
                frame.extend_from_slice(&bytes);
                while let Some(end) = frame.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = frame.drain(..=end).collect();
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    let event: Value = serde_json::from_slice(&line)?;
                    let (next, candidate) = self.watch_event(kind, &event)?;
                    version = next;
                    if let Some(candidate) = candidate {
                        let settle = self.continuity.lock().unwrap().settle;
                        held.push_back((Instant::now() + settle, candidate));
                    }
                }
            }
            self.release(&mut held, &events, true)?;
            if !frame.is_empty() {
                return Err("Kubernetes watch frame was interrupted".into());
            }
            if let Some(kind) = self.continuity.lock().unwrap().kinds.get_mut(kind) {
                kind.2 = false;
            }
        }
    }
    /// Sends the hints of the changes whose settle window is over (all of them when `all`), but for
    /// the ones whose version turned out to be this controller's own.
    fn release(
        &self,
        held: &mut VecDeque<(Instant, Candidate)>,
        events: &tokio::sync::mpsc::Sender<Trigger>,
        all: bool,
    ) -> Result<(), Error> {
        let now = Instant::now();
        while held.front().is_some_and(|(at, _)| all || *at <= now) {
            let Some((_, candidate)) = held.pop_front() else {
                break;
            };
            if self.still_a_hint(&candidate) {
                events
                    .try_send(candidate.trigger)
                    .map_err(|_| "controller hint queue exhausted")?;
            }
        }
        Ok(())
    }
    pub async fn in_cluster() -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let host = std::env::var("KUBERNETES_SERVICE_HOST")?;
        let port: u16 = std::env::var("KUBERNETES_SERVICE_PORT_HTTPS")
            .unwrap_or_else(|_| "443".into())
            .parse()?;
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        let origin = Url::parse(&format!("https://{host}:{port}"))?;
        let folder = PathBuf::from("/var/run/secrets/kubernetes.io/serviceaccount");
        let ca = tokio::fs::read(folder.join("ca.crt")).await?;
        Self::with_ca(origin, &ca, folder.join("token"))
    }
    pub fn with_ca(origin: Url, ca: &[u8], token: PathBuf) -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        if origin.scheme() != "https"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err("invalid Kubernetes endpoint".into());
        }
        let client = Client::builder()
            .tls_certs_only([reqwest::Certificate::from_pem(ca)?])
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            client,
            origin,
            token,
            continuity: Arc::new(Mutex::new(WatchContinuity::default())),
        })
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Option<Value>, Error> {
        self.request_as(method, path, body, "application/merge-patch+json")
            .await
    }
    /// `patch_type` is the Content-Type of a PATCH body; other methods send plain JSON.
    async fn request_as(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        patch_type: &str,
    ) -> Result<Option<Value>, Error> {
        crate::timing::count_call();
        let token = tokio::fs::read_to_string(&self.token).await?;
        if token.trim().is_empty() {
            return Err("Kubernetes bearer missing".into());
        }
        let mut request = self
            .client
            .request(method.clone(), self.origin.join(path)?)
            .bearer_auth(token.trim());
        if let Some(body) = body {
            let bytes = serde_json::to_vec(body)?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("Kubernetes mutation exceeds bound".into());
            }
            request = request
                .header(
                    "Content-Type",
                    if method == Method::PATCH {
                        patch_type
                    } else {
                        "application/json"
                    },
                )
                .body(bytes);
        }
        let response = request.send().await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Box::new(KubernetesError {
                status: status.as_u16(),
            }));
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    /// Reads one object from etcd: the newest version, which no write that was answered precedes.
    pub async fn read(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        self.read_with(kind, namespace, name, false).await
    }
    /// Reads one object from the API server's watch cache (`resourceVersion=0`): any version of
    /// it that the server has seen, which trails a write by the watch's lag, milliseconds. Only
    /// for an object whose newest version does not matter to what the caller does with it: one
    /// it compares with an identity it recorded, never one it patches under its resourceVersion
    /// (a version that trails makes that patch conflict) and never the read that proves nothing
    /// changed since another (that is what a read of etcd is for).
    pub async fn read_cached(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        self.read_with(kind, namespace, name, true).await
    }
    async fn read_with(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
        cached: bool,
    ) -> Result<Option<Value>, Error> {
        let mut path = named(kind, namespace, name)?;
        if cached {
            path.push_str("?resourceVersion=0");
        }
        let value = self.request(Method::GET, &path, None).await?;
        if value
            .as_ref()
            .is_some_and(|v| !is_object(v, kind, namespace, name))
        {
            return Err("Kubernetes read identity changed".into());
        }
        self.continuity.lock().unwrap().remember(
            kind,
            namespace.unwrap_or(""),
            name,
            value.as_ref(),
        );
        Ok(value)
    }
    /// Reads one object unless the watch proves it unchanged since the controller last read or
    /// wrote it, and then answers that, without a request. For the objects a pass judges that the
    /// watch follows (a version it still holds is the newest there is, up to the time an event
    /// takes) and never for the read that proves a thing is still as it was at an instant: those
    /// are `read`. A read that is made is as `read` makes it.
    pub async fn read_known(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        self.known(kind, namespace, name, false).await
    }
    /// `read_known` whose read, if one is made, is as `read_cached` makes it.
    pub async fn read_known_cached(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        self.known(kind, namespace, name, true).await
    }
    async fn known(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
        cached: bool,
    ) -> Result<Option<Value>, Error> {
        named(kind, namespace, name)?;
        let recalled = self
            .continuity
            .lock()
            .unwrap()
            .recall(kind, namespace.unwrap_or(""), name);
        if let Some(found) = recalled {
            crate::timing::count_hit();
            return Ok(found);
        }
        self.read_with(kind, namespace, name, cached).await
    }
    /// Reads `objects` (kind, namespace, name) a few at a time and answers them in the order they
    /// were asked in. They are independent reads: the answers are as of the same moment only to
    /// the extent that any run of reads is. A slow read holds back no other.
    pub async fn read_all(
        &self,
        objects: &[(&str, Option<&str>, &str)],
    ) -> Result<Vec<Option<Value>>, Error> {
        self.read_all_with(objects, false, false).await
    }
    /// `read_all` from the watch cache, for objects as `read_cached` allows.
    pub async fn read_all_cached(
        &self,
        objects: &[(&str, Option<&str>, &str)],
    ) -> Result<Vec<Option<Value>>, Error> {
        self.read_all_with(objects, true, false).await
    }
    /// `read_all` of objects as `read_known` allows.
    pub async fn read_all_known(
        &self,
        objects: &[(&str, Option<&str>, &str)],
    ) -> Result<Vec<Option<Value>>, Error> {
        self.read_all_with(objects, false, true).await
    }
    /// `read_all_known` whose reads are as `read_cached` makes them.
    pub async fn read_all_known_cached(
        &self,
        objects: &[(&str, Option<&str>, &str)],
    ) -> Result<Vec<Option<Value>>, Error> {
        self.read_all_with(objects, true, true).await
    }
    async fn read_all_with(
        &self,
        objects: &[(&str, Option<&str>, &str)],
        cached: bool,
        known: bool,
    ) -> Result<Vec<Option<Value>>, Error> {
        let mut answered: Vec<(usize, Option<Value>)> = stream::iter(objects.iter().enumerate())
            .map(|(index, (kind, namespace, name))| async move {
                let object = if known {
                    self.known(kind, *namespace, name, cached).await?
                } else {
                    self.read_with(kind, *namespace, name, cached).await?
                };
                Ok::<_, Error>((index, object))
            })
            .buffer_unordered(READ_FANOUT)
            .try_collect()
            .await?;
        answered.sort_by_key(|(index, _)| *index);
        Ok(answered.into_iter().map(|(_, object)| object).collect())
    }
    pub async fn list(
        &self,
        kind: &str,
        namespace: Option<&str>,
        selector: Option<&str>,
    ) -> Result<Vec<Value>, Error> {
        self.list_with(kind, namespace, selector, false).await
    }
    /// A list from the API server's watch cache (`resourceVersion=0`), for what `read_cached`
    /// allows. A list of etcd waits until the API server's cache has caught up with etcd's newest
    /// revision, which it learns from etcd's progress notifications, one every 100 ms while
    /// anything waits: up to that long, for every list. The cache serves the whole list at once.
    pub async fn list_cached(
        &self,
        kind: &str,
        namespace: Option<&str>,
        selector: Option<&str>,
    ) -> Result<Vec<Value>, Error> {
        self.list_with(kind, namespace, selector, true).await
    }
    async fn list_with(
        &self,
        kind: &str,
        namespace: Option<&str>,
        selector: Option<&str>,
        cached: bool,
    ) -> Result<Vec<Value>, Error> {
        let path = collection(kind, namespace)?;
        let prefix = resource(kind)?.0;
        let api_version = prefix
            .strip_prefix("/apis/")
            .or_else(|| prefix.strip_prefix("/api/"))
            .ok_or("Kubernetes API version unknown")?;
        let mut result = vec![];
        let mut cursor = String::new();
        let mut version = None;
        for _ in 0..50 {
            let mut url = self.origin.join(&path)?;
            {
                let mut query = url.query_pairs_mut();
                if cached {
                    // The cache ignores a limit and answers the whole list.
                    query.append_pair("resourceVersion", "0");
                } else {
                    query.append_pair("limit", "200");
                }
                if let Some(selector) = selector {
                    if selector.len() > 1024 {
                        return Err("Kubernetes selector exceeds bound".into());
                    }
                    query.append_pair("labelSelector", selector);
                }
                if !cursor.is_empty() {
                    query.append_pair("continue", &cursor);
                }
            }
            let target = format!("{}?{}", url.path(), url.query().unwrap_or(""));
            let value = self
                .request(Method::GET, &target, None)
                .await?
                .ok_or("Kubernetes collection missing")?;
            let current = text(&value["metadata"], "resourceVersion");
            if current.is_empty() || version.as_ref().is_some_and(|old| old != current) {
                return Err("Kubernetes paginated inventory changed".into());
            }
            version = Some(current.to_string());
            let items = value["items"]
                .as_array()
                .ok_or("Kubernetes collection invalid")?;
            // kube-apiserver omits TypeMeta on built-in list items; a stated identity must match.
            if items.iter().any(|v| {
                (!v["kind"].is_null() && text(v, "kind") != kind)
                    || (!v["apiVersion"].is_null() && text(v, "apiVersion") != api_version)
                    || namespace.is_some_and(|ns| text(&v["metadata"], "namespace") != ns)
            }) {
                return Err("Kubernetes inventory identity changed".into());
            }
            result.extend(items.iter().map(|item| {
                let mut item = item.clone();
                item["kind"] = kind.into();
                item["apiVersion"] = api_version.into();
                item
            }));
            if result.len() > 10000 {
                return Err("Kubernetes inventory exceeds bound".into());
            }
            cursor = text(&value["metadata"], "continue").to_string();
            if cursor.is_empty() {
                return Ok(result);
            }
            if cached {
                return Err("Kubernetes cached list was not whole".into());
            }
        }
        Err("Kubernetes pagination exceeds bound".into())
    }
    pub async fn create(&self, manifest: &Value) -> Result<Value, Error> {
        let kind = text(manifest, "kind");
        let ns = manifest["metadata"]["namespace"].as_str();
        let name = text(&manifest["metadata"], "name");
        named(kind, ns, name)?;
        if !manifest["metadata"]["uid"].is_null()
            || !manifest["metadata"]["resourceVersion"].is_null()
        {
            return Err("new Kubernetes resource has an existing identity".into());
        }
        let response = self
            .request(Method::POST, &collection(kind, ns)?, Some(manifest))
            .await?
            .ok_or("Kubernetes create result unknown")?;
        self.continuity.lock().unwrap().wrote(kind, &response, "");
        let uid = text(&response["metadata"], "uid");
        let actual = self
            .read(kind, ns, name)
            .await?
            .ok_or("Kubernetes created resource disappeared")?;
        if uid.is_empty()
            || text(&actual["metadata"], "uid") != uid
            || text(&actual["metadata"], "resourceVersion").is_empty()
        {
            return Err("Kubernetes created identity changed".into());
        }
        Ok(actual)
    }
    /// Merge-patches `current` under its UID and resourceVersion and returns the object as the
    /// server answered the write: the answer is the object as it was written, so it is not read
    /// again. A write whose answer did not arrive is an error, and whoever needs to know whether it
    /// committed reads the object.
    pub async fn patch(&self, current: &Value, patch: &Value) -> Result<Value, Error> {
        let kind = text(current, "kind");
        let ns = current["metadata"]["namespace"].as_str();
        let name = text(&current["metadata"], "name");
        let uid = text(&current["metadata"], "uid");
        let rv = text(&current["metadata"], "resourceVersion");
        if uid.is_empty() || rv.is_empty() || !current["metadata"]["deletionTimestamp"].is_null() {
            return Err("Kubernetes mutation identity unavailable".into());
        }
        let mut body = patch.clone();
        if !body.is_object() {
            return Err("Kubernetes patch must be object".into());
        }
        if !body["metadata"].is_object() {
            body["metadata"] = json!({});
        }
        body["metadata"]["uid"] = uid.into();
        body["metadata"]["resourceVersion"] = rv.into();
        let result = self
            .request(Method::PATCH, &named(kind, ns, name)?, Some(&body))
            .await?
            .ok_or("Kubernetes patch target disappeared")?;
        if text(&result["metadata"], "uid") != uid
            || !is_object(&result, kind, ns, name)
            || text(&result["metadata"], "resourceVersion").is_empty()
        {
            return Err("Kubernetes patched identity changed".into());
        }
        {
            let mut state = self.continuity.lock().unwrap();
            state.wrote(kind, &result, rv);
            state.remember(kind, ns.unwrap_or(""), name, Some(&result));
        }
        Ok(result)
    }
    /// Resizes the requests of named containers of a running Pod in place, through the `resize`
    /// subresource. It is a strategic merge, because a JSON merge patch would replace the
    /// container lists, and its only precondition is the Pod's UID: a Pod's resourceVersion churns
    /// with every status write. Only requests are sent, so limits and the QoS class stay.
    pub async fn resize_pod(
        &self,
        pod: &Value,
        containers: &[(&str, Value)],
        init_containers: &[(&str, Value)],
    ) -> Result<Value, Error> {
        let uid = text(&pod["metadata"], "uid");
        let name = text(&pod["metadata"], "name");
        let ns = pod["metadata"]["namespace"].as_str();
        if uid.is_empty()
            || text(pod, "kind") != "Pod"
            || ns.is_none()
            || !pod["metadata"]["deletionTimestamp"].is_null()
            || containers.is_empty()
        {
            return Err("Kubernetes resize identity unavailable".into());
        }
        let list = |items: &[(&str, Value)]| -> Vec<Value> {
            items
                .iter()
                .map(|(name, requests)| json!({"name":name,"resources":{"requests":requests}}))
                .collect()
        };
        let mut spec = json!({"containers":list(containers)});
        if !init_containers.is_empty() {
            spec["initContainers"] = list(init_containers).into();
        }
        let body = json!({"metadata":{"uid":uid},"spec":spec});
        let path = format!("{}/resize", named("Pod", ns, name)?);
        let result = self
            .request_as(
                Method::PATCH,
                &path,
                Some(&body),
                "application/strategic-merge-patch+json",
            )
            .await?
            .ok_or("Kubernetes resize target disappeared")?;
        if text(&result["metadata"], "uid") != uid || !is_object(&result, "Pod", ns, name) {
            return Err("Kubernetes resized identity changed".into());
        }
        {
            let mut state = self.continuity.lock().unwrap();
            state.wrote("Pod", &result, text(&pod["metadata"], "resourceVersion"));
            state.remember("Pod", ns.unwrap_or(""), name, Some(&result));
        }
        Ok(result)
    }
    pub async fn delete(&self, current: &Value, propagation: &str) -> Result<(), Error> {
        let uid = text(&current["metadata"], "uid");
        let rv = text(&current["metadata"], "resourceVersion");
        if uid.is_empty()
            || rv.is_empty()
            || !["Foreground", "Background", "Orphan"].contains(&propagation)
        {
            return Err("Kubernetes deletion identity unavailable".into());
        }
        let body = json!({"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":uid,"resourceVersion":rv},"propagationPolicy":propagation});
        self.request(
            Method::DELETE,
            &named(
                text(current, "kind"),
                current["metadata"]["namespace"].as_str(),
                text(&current["metadata"], "name"),
            )?,
            Some(&body),
        )
        .await?;
        Ok(())
    }
    /// Authenticated API-server proxy to the read-only OpenEBS LVM exporter of one driver Pod.
    pub async fn openebs_metrics(&self, pod: &str) -> Result<String, Error> {
        if pod.len() > 63 || pod.contains('.') || !identifier(pod) {
            return Err("storage exporter Pod invalid".into());
        }
        let token = tokio::fs::read_to_string(&self.token).await?;
        if token.trim().is_empty() {
            return Err("Kubernetes bearer missing".into());
        }
        let response = self
            .client
            .get(self.origin.join(&format!(
                "/api/v1/namespaces/openebs/pods/{pod}:9500/proxy/metrics"
            ))?)
            .bearer_auth(token.trim())
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        if response.status() != StatusCode::OK {
            return Err("storage metrics unavailable".into());
        }
        Ok(String::from_utf8_lossy(&bounded(response, 2 * 1024 * 1024).await?).into_owned())
    }
    pub async fn assert_cluster(&self, uid: &str) -> Result<(), Error> {
        // The UID of a Namespace never changes: any version of it says which cluster this is.
        let cluster = self
            .read_known_cached("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity missing")?;
        if uid.is_empty() || text(&cluster["metadata"], "uid") != uid {
            return Err("cluster identity changed".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_runtime_proof_is_current_only_while_the_watch_holds_every_resource_it_names() {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let kube = Kubernetes::with_ca(
            Url::parse("https://localhost/").unwrap(),
            identity.cert.pem().as_bytes(),
            PathBuf::from("unused-runtime-proof-token"),
        )
        .unwrap();
        let mut proof = serde_json::json!({"observation":{"expires_at":u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()+1000,"resource_versions":{}}});
        let pod = serde_json::json!({"metadata":{"name":"pod","uid":"00000000-0000-4000-8000-000000000003","resourceVersion":"7"}});
        {
            let mut state = kube.continuity.lock().unwrap();
            for kind in RUNTIME_WATCH_KINDS {
                state.connected(kind, "7");
            }
            for (index, (field, kind, uid)) in [
                ("namespace", "Namespace", "namespace_uid"),
                ("cluster", "Cluster", "cnpg_cluster_uid"),
                ("pod", "Pod", "pod_uid"),
                ("ca_secret", "Secret", "ca_secret_uid"),
                ("storage", "ConfigMap", "storage_uid"),
                ("pvc", "PersistentVolumeClaim", "pvc_uid"),
                ("pv", "PersistentVolume", "pv_uid"),
                ("node", "Node", "node_uid"),
            ]
            .iter()
            .enumerate()
            {
                let id = format!("00000000-0000-4000-8000-{:012}", index + 1);
                proof[*uid] = id.clone().into();
                proof["observation"]["resource_versions"][*field] = "7".into();
                assert!(state.observe(
                    kind,
                    &serde_json::json!({"metadata":{"name":field,"uid":id,"resourceVersion":"7"}}),
                    false
                ));
            }
            proof["observation"]["controller_epoch"] = state.controller_epoch.clone().into();
            proof["observation"]["watch_epoch"] = state.epoch.into();
        }
        assert!(kube.runtime_proof_current(&proof));
        kube.continuity.lock().unwrap().observe("Pod", &pod, true);
        assert!(
            !kube.runtime_proof_current(&proof),
            "the watch no longer holds the Pod the proof names"
        );
    }
    #[tokio::test]
    async fn a_write_of_the_controller_is_observed_once_its_watch_delivers_it() {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let kube = Kubernetes::with_ca(
            Url::parse("https://localhost/").unwrap(),
            identity.cert.pem().as_bytes(),
            PathBuf::from("unused-observed-token"),
        )
        .unwrap();
        let namespace = serde_json::json!({"kind":"Namespace","metadata":{"name":"pgcf-db-a","uid":"01234567-89ab-4def-8123-0123456789ab","resourceVersion":"2"}});
        assert!(
            !kube.observed(&namespace, Duration::from_millis(20)).await,
            "nothing is watched yet"
        );
        let watch = kube.clone();
        let delivered = namespace.clone();
        let delivery = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            watch.mirror([&delivered]);
        });
        assert!(kube.observed(&namespace, Duration::from_secs(5)).await);
        delivery.await.unwrap();
        let mut newer = namespace.clone();
        newer["metadata"]["resourceVersion"] = "3".into();
        assert!(
            !kube.observed(&newer, Duration::from_millis(20)).await,
            "the version the watch holds is not the newer write"
        );
    }
    #[tokio::test]
    async fn a_patch_and_a_resize_are_answered_by_the_server_and_not_read_again() {
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"owned","namespace":"pgcf-system","uid":uid(1)},"data":{"value":"old"}}));
        server.put(serde_json::json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":"pgcf-db-a","uid":uid(2)},
            "spec":{"containers":[{"name":"postgres","resources":{"requests":{"cpu":"25m","memory":"128Mi"}}}]},"status":{}}));
        let map = server
            .k8s
            .read("ConfigMap", Some("pgcf-system"), "owned")
            .await
            .unwrap()
            .unwrap();
        let pod = server
            .k8s
            .read("Pod", Some("pgcf-db-a"), "database-1")
            .await
            .unwrap()
            .unwrap();
        let reads = server.state.lock().unwrap().requests.len();
        let patched = server
            .k8s
            .patch(&map, &serde_json::json!({"data":{"value":"new"}}))
            .await
            .unwrap();
        assert_eq!(patched["data"]["value"], "new");
        assert_eq!(patched["metadata"]["uid"], map["metadata"]["uid"]);
        assert_ne!(
            patched["metadata"]["resourceVersion"],
            map["metadata"]["resourceVersion"]
        );
        let resized = server
            .k8s
            .resize_pod(
                &pod,
                &[("postgres", serde_json::json!({"cpu":"10m","memory":"96Mi"}))],
                &[],
            )
            .await
            .unwrap();
        assert_eq!(
            resized["spec"]["containers"][0]["resources"]["requests"],
            serde_json::json!({"cpu":"10m","memory":"96Mi"})
        );
        // One request each: the answer of a write is the object as it was written.
        assert_eq!(
            server.state.lock().unwrap().requests[reads..],
            [
                (
                    "PATCH".to_string(),
                    "/api/v1/namespaces/pgcf-system/configmaps/owned".to_string()
                ),
                (
                    "PATCH".to_string(),
                    "/api/v1/namespaces/pgcf-db-a/pods/database-1/resize".to_string()
                ),
            ]
        );
        // An answer for another object is no answer.
        let other = serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"other","namespace":"pgcf-system","uid":uid(1),"resourceVersion":"1"}});
        assert!(
            server
                .k8s
                .patch(&other, &serde_json::json!({"data":{"value":"x"}}))
                .await
                .is_err()
        );
    }
    fn meta_event(kind: &str, event_type: &str, metadata: Value) -> Value {
        serde_json::json!({"type":event_type,"object":{"apiVersion":"meta.k8s.io/v1","kind":kind,"metadata":metadata}})
    }
    #[test]
    fn the_controllers_own_records_and_the_status_of_a_cluster_hint_nothing() {
        // Live, an awake thin database was reconciled every two seconds, the cadence at which
        // its ledger is written. The records of pgcf-system are written by this controller alone;
        // a Cluster whose resourceVersion moves by a status write has changed nothing a pass
        // decides on that its Pod, its Secrets and its own writes do not already say.
        let mut state = WatchContinuity::default();
        let id = "dbbbbbbbbbbbbbbbbbbb";
        let namespace = format!("pgcf-db-{id}");
        let record = |version: &str, event_type: &str| {
            meta_event(
                "ConfigMap",
                event_type,
                serde_json::json!({"name":format!("storage-{id}"),"namespace":"pgcf-system","uid":"u-1","resourceVersion":version,"labels":{"pgcf.io/database-id":id}}),
            )
        };
        assert_eq!(
            state
                .event("ConfigMap", &record("5", "MODIFIED"))
                .unwrap()
                .1,
            None,
            "a record of this controller, written by it"
        );
        assert!(
            state
                .event("ConfigMap", &record("6", "DELETED"))
                .unwrap()
                .1
                .is_some(),
            "a record that was deleted is news"
        );
        let monitoring = meta_event(
            "ConfigMap",
            "MODIFIED",
            serde_json::json!({"name":"cnpg-monitoring","namespace":namespace,"uid":"u-2","resourceVersion":"5"}),
        );
        assert!(state.event("ConfigMap", &monitoring).unwrap().1.is_some());
        let cluster = |version: &str, generation: u64, annotations: Value, event_type: &str| {
            meta_event(
                "Cluster",
                event_type,
                serde_json::json!({"name":"database","namespace":namespace,"uid":"u-3","resourceVersion":version,"generation":generation,"annotations":annotations}),
            )
        };
        let hinted = |state: &mut WatchContinuity, event: &Value| {
            state.event("Cluster", event).unwrap().1.is_some()
        };
        let marked = serde_json::json!({"cnpg.io/hibernation":"off"});
        assert!(hinted(
            &mut state,
            &cluster("10", 2, marked.clone(), "ADDED")
        ));
        assert!(
            !hinted(&mut state, &cluster("11", 2, marked.clone(), "MODIFIED")),
            "a status write moves the resourceVersion alone"
        );
        assert!(
            hinted(&mut state, &cluster("12", 3, marked.clone(), "MODIFIED")),
            "a change of the spec moves the generation"
        );
        assert!(
            hinted(
                &mut state,
                &cluster(
                    "13",
                    3,
                    serde_json::json!({"cnpg.io/hibernation":"on"}),
                    "MODIFIED"
                )
            ),
            "an annotation is what PGCF and CNPG ask each other with"
        );
        assert!(hinted(
            &mut state,
            &cluster("14", 3, marked.clone(), "MODIFIED")
        ));
        assert!(!hinted(
            &mut state,
            &cluster("15", 3, marked.clone(), "MODIFIED")
        ));
        assert!(hinted(&mut state, &cluster("16", 3, marked, "DELETED")));
        // Only a custom resource's status is separate from the rest of it: a Pod's status is
        // what the pass reads.
        let pod = |version: &str| {
            meta_event(
                "Pod",
                "MODIFIED",
                serde_json::json!({"name":"database-1","namespace":namespace,"uid":"u-4","resourceVersion":version,"generation":1}),
            )
        };
        assert!(state.event("Pod", &pod("20")).unwrap().1.is_some());
        assert!(state.event("Pod", &pod("21")).unwrap().1.is_some());
    }
    #[test]
    fn a_slot_object_hints_its_slot_and_the_database_that_claimed_it() {
        let mut state = WatchContinuity::default();
        let namespace = "pgcf-slot-0a1b2c3d";
        let pod = |version: &str| {
            meta_event(
                "Pod",
                "MODIFIED",
                serde_json::json!({"name":"database-1","namespace":namespace,"uid":"u-1","resourceVersion":version,"labels":{"pgcf.io/slot":"0a1b2c3d"}}),
            )
        };
        // A free slot is no database's: its objects hint the slot alone.
        let free = state.event("Pod", &pod("1")).unwrap().1.unwrap().trigger;
        assert_eq!(
            free,
            Trigger {
                database: String::new(),
                name: "database-1".into(),
                slot: Some("0a1b2c3d".into())
            }
        );
        // Claimed, they hint the database it serves as well.
        state.index_slot(namespace, Some("dbbbbbbbbbbbbbbbbbbb"));
        let claimed = state.event("Pod", &pod("2")).unwrap().1.unwrap().trigger;
        assert_eq!(claimed.database, "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(claimed.slot.as_deref(), Some("0a1b2c3d"));
        // The slot namespace itself names its slot.
        let deleted = meta_event(
            "Namespace",
            "DELETED",
            serde_json::json!({"name":namespace,"uid":"u-2","resourceVersion":"3","labels":{"pgcf.io/slot":"0a1b2c3d"}}),
        );
        let gone = state
            .event("Namespace", &deleted)
            .unwrap()
            .1
            .unwrap()
            .trigger;
        assert_eq!(gone.slot.as_deref(), Some("0a1b2c3d"));
        assert_eq!(gone.database, "dbbbbbbbbbbbbbbbbbbb");
        state.index_slot(namespace, None);
        assert_eq!(
            state
                .event("Pod", &pod("4"))
                .unwrap()
                .1
                .unwrap()
                .trigger
                .database,
            ""
        );
        // A namespace that only looks like one is not a slot.
        let other = meta_event(
            "Pod",
            "MODIFIED",
            serde_json::json!({"name":"x","namespace":"pgcf-slot-0A1B2C3D","uid":"u-3","resourceVersion":"5"}),
        );
        assert_eq!(state.event("Pod", &other).unwrap().1, None);
        // A database's own objects carry no slot.
        let tenant = meta_event(
            "Pod",
            "MODIFIED",
            serde_json::json!({"name":"database-1","namespace":"pgcf-db-dbbbbbbbbbbbbbbbbbbb","uid":"u-4","resourceVersion":"6"}),
        );
        assert_eq!(
            state.event("Pod", &tenant).unwrap().1.unwrap().trigger.slot,
            None
        );
    }
    /// Opens the metadata watch of `kind` on the double and waits until it is established.
    async fn watching(
        server: &crate::test_server::Server,
        kind: &'static str,
    ) -> (
        tokio::sync::mpsc::Receiver<Trigger>,
        tokio::task::JoinHandle<Result<(), Error>>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let k8s = server.k8s.clone();
        let task = tokio::spawn(async move {
            k8s.watch_database_ids(kind, sender)
                .await
                .map_err(|error| Error::from(error.to_string()))
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            while server.state.lock().unwrap().streams.is_empty() {
                assert!(
                    !task.is_finished(),
                    "the watch ended before it was established"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the watch is established");
        (receiver, task)
    }
    #[tokio::test]
    async fn a_baseline_of_many_pages_is_the_whole_of_the_kind_at_one_revision() {
        // A cluster of a hundred databases holds thousands of Secrets and ConfigMaps; the API
        // server answers a list in pages, and a baseline that read the first page only, or
        // refused one with more, left the controller without a watch for good.
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        for n in 0..1300_u64 {
            server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("map-{n}"),"namespace":format!("pgcf-db-{:020}", n % 130),"uid":uid(n + 1000)}}));
        }
        let (_hints, watch) = watching(&server, "ConfigMap").await;
        // The watch is covered once the API server has answered it.
        tokio::time::timeout(Duration::from_secs(5), async {
            while !server
                .k8s
                .continuity
                .lock()
                .unwrap()
                .kinds
                .contains_key("ConfigMap")
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the watch is covered");
        {
            let state = server.k8s.continuity.lock().unwrap();
            let held = state
                .objects
                .keys()
                .filter(|(kind, _, _)| kind == "ConfigMap");
            assert_eq!(held.count(), 1300);
        }
        // Several pages, each of the size the controller asks for.
        let pages: Vec<String> = {
            let state = server.state.lock().unwrap();
            state
                .requests
                .iter()
                .zip(&state.queries)
                .filter(|((_, path), query)| {
                    path.ends_with("/configmaps") && !query.contains("watch")
                })
                .map(|(_, query)| query.clone())
                .collect()
        };
        assert!(pages.len() > 1, "{pages:?}");
        assert!(
            pages.iter().all(|query| query.contains("limit=")),
            "{pages:?}"
        );
        watch.abort();
    }
    #[tokio::test]
    async fn an_event_that_arrives_before_the_answer_of_its_own_write_hints_nothing() {
        // The API server tells its watches of a write about as it answers the writer, and which
        // of the two reaches this controller first is not up to it. When the event comes first,
        // the version it names is not yet known to be the controller's own: live, that was a
        // hint, and a pass, for the writes the sampler makes every two seconds.
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        let id = "dbbbbbbbbbbbbbbbbbbb";
        let namespace = format!("pgcf-db-{id}");
        server.put(serde_json::json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"maintenance-credentials","namespace":namespace,"uid":uid(1),"labels":{"pgcf.io/database-id":id}},"data":{"password":"1"}}));
        let (mut hints, watch) = watching(&server, "Secret").await;
        // The answer of the write trails its event by far more than the window of production, so
        // the window is the test's.
        server.k8s.settle_within(Duration::from_millis(250));
        server.state.lock().unwrap().write_reply_delay = Some(Duration::from_millis(100));
        let current = server
            .k8s
            .read("Secret", Some(&namespace), "maintenance-credentials")
            .await
            .unwrap()
            .unwrap();
        server
            .k8s
            .patch(&current, &serde_json::json!({"data":{"password":"2"}}))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            hints.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty),
            "the controller's own write hinted its database"
        );
        // The same object written by someone else is news, and is not held back for long.
        server.state.lock().unwrap().write_reply_delay = None;
        server.external_write(
            "Secret",
            Some(&namespace),
            "maintenance-credentials",
            |secret| secret["data"]["password"] = "3".into(),
        );
        let hint = tokio::time::timeout(Duration::from_secs(3), hints.recv())
            .await
            .expect("a change by someone else hints")
            .unwrap();
        assert_eq!(
            hint,
            Trigger {
                database: id.into(),
                name: "maintenance-credentials".into(),
                slot: None
            }
        );
        watch.abort();
    }
    #[tokio::test]
    async fn a_cached_read_and_a_cached_list_ask_the_watch_cache_and_the_plain_ones_ask_etcd() {
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        for (n, name) in ["one", "two"].into_iter().enumerate() {
            server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":"pgcf-system","uid":uid(n as u64 + 1),"labels":{"app":"x"}},"data":{}}));
        }
        let from = server.state.lock().unwrap().requests.len();
        let plain = server
            .k8s
            .read("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap();
        let cached = server
            .k8s
            .read_cached("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap();
        assert_eq!(plain, cached);
        let all = server
            .k8s
            .read_all_cached(&[
                ("ConfigMap", Some("pgcf-system"), "one"),
                ("ConfigMap", Some("pgcf-system"), "missing"),
            ])
            .await
            .unwrap();
        assert!(all[0].is_some() && all[1].is_none());
        let listed = server
            .k8s
            .list("ConfigMap", Some("pgcf-system"), Some("app=x"))
            .await
            .unwrap();
        let from_cache = server
            .k8s
            .list_cached("ConfigMap", Some("pgcf-system"), Some("app=x"))
            .await
            .unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed, from_cache);
        let state = server.state.lock().unwrap();
        let queries = &state.queries[from..];
        assert_eq!(queries[0], "", "a plain read asks etcd");
        assert_eq!(queries[1], "resourceVersion=0");
        assert_eq!(queries[2], "resourceVersion=0");
        assert_eq!(queries[3], "resourceVersion=0");
        assert!(
            queries[4].starts_with("limit=200") && !queries[4].contains("resourceVersion"),
            "a plain list pages through etcd: {}",
            queries[4]
        );
        assert!(
            queries[5].contains("resourceVersion=0") && !queries[5].contains("limit"),
            "a cached list is the whole list of the cache: {}",
            queries[5]
        );
    }
    #[tokio::test]
    async fn an_object_the_watch_holds_at_the_version_that_was_read_is_not_read_again() {
        // What a pass read and the watch has not seen change since is the object as it stands: the
        // watch delivers every change of it, so a version it still holds is the object's newest.
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"one","namespace":"pgcf-system","uid":uid(1)},"data":{"a":"1"}}));
        server.watch();
        let asked = |server: &Server| server.state.lock().unwrap().requests.len();
        let from = asked(&server);
        let first = server
            .k8s
            .read_known("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(asked(&server) - from, 1, "nothing was known of it yet");
        let again = server
            .k8s
            .read_known_cached("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(again, first);
        assert_eq!(
            asked(&server) - from,
            1,
            "the watch still holds that version"
        );
        // Someone else writes it: the watch holds another version, and the object is read.
        server.external_write("ConfigMap", Some("pgcf-system"), "one", |map| {
            map["data"]["a"] = "2".into();
        });
        let changed = server
            .k8s
            .read_known("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(changed["data"]["a"], "2");
        assert_eq!(asked(&server) - from, 2);
        // A write of the controller's own leaves the object as the server answered it.
        let written = server
            .k8s
            .patch(&changed, &serde_json::json!({"data":{"a":"3"}}))
            .await
            .unwrap();
        let known = server
            .k8s
            .read_known("ConfigMap", Some("pgcf-system"), "one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(known, written);
        assert_eq!(asked(&server) - from, 3, "only the patch was asked");
    }
    #[tokio::test]
    async fn an_object_is_read_whenever_the_watch_cannot_vouch_for_what_was_read() {
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"one","namespace":"pgcf-system","uid":uid(1)},"data":{}}));
        let asked = |server: &Server| server.state.lock().unwrap().requests.len();
        let read = |server: &Server| {
            let k8s = server.k8s.clone();
            async move {
                k8s.read_known("ConfigMap", Some("pgcf-system"), "one")
                    .await
            }
        };
        // No watch: every read is a read.
        let from = asked(&server);
        read(&server).await.unwrap();
        read(&server).await.unwrap();
        assert_eq!(asked(&server) - from, 2);
        // A watch that holds the kind vouches for what was read before it began, until it has a
        // gap.
        server.watch();
        read(&server).await.unwrap();
        read(&server).await.unwrap();
        assert_eq!(asked(&server) - from, 2);
        server.k8s.continuity.lock().unwrap().gap("ConfigMap");
        read(&server).await.unwrap();
        assert_eq!(
            asked(&server) - from,
            3,
            "a kind without a live watch is read"
        );
        // What was found to be absent stays absent while the watch holds the kind and does not
        // hold the object; the object appearing is a change like any other.
        server.watch();
        let missing = |server: &Server| {
            let k8s = server.k8s.clone();
            async move {
                k8s.read_known("ConfigMap", Some("pgcf-system"), "two")
                    .await
            }
        };
        assert!(missing(&server).await.unwrap().is_none());
        let before = asked(&server);
        assert!(missing(&server).await.unwrap().is_none());
        assert_eq!(asked(&server), before, "absence is remembered");
        server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"two","namespace":"pgcf-system","uid":uid(2)},"data":{}}));
        assert!(missing(&server).await.unwrap().is_some());
        assert_eq!(asked(&server), before + 1);
    }
    #[tokio::test]
    async fn the_event_of_a_version_the_controller_wrote_hints_nothing_and_any_other_does() {
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        let id = "dbbbbbbbbbbbbbbbbbbb";
        let name = "maintenance-credentials".to_string();
        let namespace = format!("pgcf-db-{id}");
        server.put(serde_json::json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":name,"namespace":namespace,"uid":uid(1),"labels":{"pgcf.io/database-id":id}},"data":{"password":"1"}}));
        let current = server
            .k8s
            .read("Secret", Some(&namespace), &name)
            .await
            .unwrap()
            .unwrap();
        let written = server
            .k8s
            .patch(&current, &serde_json::json!({"data":{"password":"2"}}))
            .await
            .unwrap();
        let events = std::mem::take(&mut server.state.lock().unwrap().events);
        assert_eq!(events.len(), 1);
        let (version, hint) = server.k8s.watch_event("Secret", &events[0].1).unwrap();
        assert_eq!(version, written["metadata"]["resourceVersion"]);
        assert_eq!(hint, None, "the write of this controller is not news");
        // Someone else writes the same object next: a version of its own, and a hint. The
        // memory of the controller's write ended with its event.
        let mut other = events[0].1.clone();
        other["object"]["metadata"]["resourceVersion"] = "9".into();
        let trigger = Trigger {
            database: id.to_string(),
            name: name.clone(),
            slot: None,
        };
        let (version, candidate) = server.k8s.watch_event("Secret", &other).unwrap();
        assert_eq!(
            (version, candidate.map(|candidate| candidate.trigger)),
            ("9".to_string(), Some(trigger.clone()))
        );
        assert_eq!(
            server
                .k8s
                .watch_event("Secret", &events[0].1)
                .unwrap()
                .1
                .map(|candidate| candidate.trigger),
            Some(trigger)
        );
        // A write that changed nothing answers the version it was made over, leaves no event
        // and is not remembered.
        let version = written["metadata"]["resourceVersion"].as_str().unwrap();
        server
            .k8s
            .continuity
            .lock()
            .unwrap()
            .wrote("Secret", &written, version);
        assert!(server.k8s.continuity.lock().unwrap().written.is_empty());
    }
    #[test]
    fn a_remembered_write_is_bounded_and_only_watched_kinds_are_remembered() {
        let mut state = WatchContinuity::default();
        let object = |kind: &str, rv: &str| serde_json::json!({"kind":kind,"metadata":{"name":"x","namespace":"pgcf-system","uid":"u","resourceVersion":rv}});
        // A kind no watch delivers is never waited for.
        state.wrote("ResourceQuota", &object("ResourceQuota", "5"), "4");
        assert!(state.written.is_empty());
        for version in 10..40 {
            state.wrote(
                "ConfigMap",
                &object("ConfigMap", &version.to_string()),
                &(version - 1).to_string(),
            );
        }
        let held = state.written.values().next().unwrap();
        assert_eq!(held.len(), OWN_WRITES_PER_OBJECT);
        // The oldest versions were forgotten, the newest are still the controller's.
        assert!(!state.own("ConfigMap", &object("ConfigMap", "10")));
        assert!(state.own("ConfigMap", &object("ConfigMap", "39")));
        assert!(!state.own("ConfigMap", &object("ConfigMap", "39")));
    }
    #[test]
    fn watch_gap_changes_coverage_but_ordinary_events_and_own_publication_do_not() {
        let mut state = WatchContinuity::default();
        assert!(state.snapshot().is_none());
        for kind in RUNTIME_WATCH_KINDS {
            state.connected(kind, "7");
        }
        let selected = serde_json::json!({"kind":"Secret","metadata":{"name":"database-ca","namespace":"pgcf-db-aaaaaaaaaaaaaaaaaaaa","uid":"01234567-89ab-4def-8123-0123456789ab","resourceVersion":"7"}});
        state.observe("Secret", &selected, false);
        let before = state.snapshot().unwrap();
        let publication = serde_json::json!({"metadata":{"name":"gateway-fence-aaaaaaaaaaaaaaaaaaaa","namespace":"pgcf-system","uid":"01234567-89ab-4def-8123-0123456789ab","resourceVersion":"8"}});
        state.observe("ConfigMap", &publication, false);
        assert_eq!(before, state.snapshot().unwrap());
        assert!(state.resource_current("Secret", &selected));
        let mut replaced = selected.clone();
        replaced["metadata"]["resourceVersion"] = "9".into();
        state.observe("Secret", &replaced, false);
        assert!(!state.resource_current("Secret", &selected));
        assert_eq!(before, state.snapshot().unwrap());
        state.gap("Secret");
        assert!(state.snapshot().is_none());
        state.connected("Secret", "10");
        assert_ne!(before, state.snapshot().unwrap());
        assert!(!state.resource_current("Secret", &replaced));
    }
    #[test]
    fn expired_watch_is_never_complete_coverage() {
        let mut state = WatchContinuity::default();
        for kind in RUNTIME_WATCH_KINDS {
            state.connected(kind, "7");
        }
        state.kinds.get_mut("Node").unwrap().1 =
            std::time::Instant::now() - std::time::Duration::from_secs(71);
        assert!(state.snapshot().is_none());
    }
    #[test]
    fn kubelet_certificate_requires_exact_leaf_and_exact_node_san() {
        use rustls::client::danger::ServerCertVerifier;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["customer-node".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let der = rustls::pki_types::CertificateDer::from(cert.der().to_vec());
        let mut roots = rustls::RootCertStore::empty();
        roots.add(der.clone()).unwrap();
        let inner = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .unwrap();
        let verifier = KubeletVerifier {
            inner,
            leaf: der.as_ref().to_vec(),
            name: "customer-node".into(),
        };
        let name = rustls::pki_types::ServerName::try_from("customer-node").unwrap();
        assert!(
            verifier
                .verify_server_cert(&der, &[], &name, &[], rustls::pki_types::UnixTime::now())
                .is_ok()
        );
        let other = rcgen::CertificateParams::new(vec!["customer-node".into()])
            .unwrap()
            .self_signed(&rcgen::KeyPair::generate().unwrap())
            .unwrap();
        assert!(
            verifier
                .verify_server_cert(
                    other.der(),
                    &[],
                    &name,
                    &[],
                    rustls::pki_types::UnixTime::now()
                )
                .is_err()
        );
        let wrong = rustls::pki_types::ServerName::try_from("another-node").unwrap();
        assert!(
            verifier
                .verify_server_cert(&der, &[], &wrong, &[], rustls::pki_types::UnixTime::now())
                .is_err()
        );
    }
    #[test]
    fn resource_paths_are_fixed_and_names_cannot_escape() {
        assert_eq!(
            named("Cluster", Some("pgcf-db-test"), "database").unwrap(),
            "/apis/postgresql.cnpg.io/v1/namespaces/pgcf-db-test/clusters/database"
        );
        assert!(named("Secret", Some("a/../b"), "credentials").is_err());
        assert!(named("Secret", Some(".."), "credentials").is_err());
        assert!(named("Secret", Some("pgcf-system"), "..").is_err());
        assert!(named("Cluster", None, "database").is_err());
        assert!(collection("Deployment", Some("kube-system")).is_err());
        assert_eq!(
            named("RuntimeClass", None, "pgcf-prestarted").unwrap(),
            "/apis/node.k8s.io/v1/runtimeclasses/pgcf-prestarted"
        );
        assert!(named("MutatingAdmissionPolicy", Some("kube-system"), "policy").is_err());
    }
}
#[cfg(test)]
mod list_tests {
    use crate::test_server::{Server, uid};
    use serde_json::json;
    #[tokio::test]
    async fn built_in_list_items_without_type_meta_keep_the_requested_identity() {
        let server = Server::start().await;
        server.put(
            json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"customer","uid":uid(1)}}),
        );
        server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"driver","namespace":"openebs","uid":uid(2)}}));
        let nodes = server.k8s.list("Node", None, None).await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["kind"], "Node");
        assert_eq!(nodes[0]["apiVersion"], "v1");
        let pods = server.k8s.list("Pod", None, None).await.unwrap();
        assert_eq!(pods[0]["kind"], "Pod");
        assert_eq!(pods[0]["metadata"]["uid"], uid(2));
        server.state.lock().unwrap().objects.insert(
            "/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmvolumes/changed".into(),
            json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMNode","metadata":{"name":"changed","namespace":"openebs","uid":uid(3)}}),
        );
        assert!(
            server
                .k8s
                .list("LVMVolume", Some("openebs"), None)
                .await
                .is_err()
        );
    }
}
#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tokio_rustls::TlsAcceptor;
    #[tokio::test]
    async fn uncertain_patch_is_not_retried_and_next_read_uses_rotated_token() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![identity.cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(
                    rustls::pki_types::PrivatePkcs8KeyDer::from(
                        identity.signing_key.serialize_der(),
                    ),
                ),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = std::env::temp_dir().join(format!(
            "pgcf-kube-client-{}-{}.token",
            std::process::id(),
            address.port()
        ));
        tokio::fs::write(&token, "before").await.unwrap();
        let k8s = Kubernetes::with_ca(
            Url::parse(&format!("https://{address}/")).unwrap(),
            identity.cert.pem().as_bytes(),
            token.clone(),
        )
        .unwrap();
        let current = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"owned","namespace":"pgcf-system","uid":"same","resourceVersion":"1"},"data":{"value":"old"}});
        let state = Arc::new(Mutex::new(current.clone()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (saved, count) = (state.clone(), attempts.clone());
        let task = tokio::spawn(async move {
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut tls = acceptor.accept(tcp).await.unwrap();
                let mut header = vec![];
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    tls.read_exact(&mut byte).await.unwrap();
                    header.push(byte[0]);
                    assert!(header.len() < 64 * 1024);
                }
                let header = String::from_utf8(header).unwrap();
                assert!(
                    header
                        .lines()
                        .next()
                        .unwrap()
                        .ends_with("/api/v1/namespaces/pgcf-system/configmaps/owned HTTP/1.1")
                );
                if header.starts_with("PATCH ") {
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer before")
                    );
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    let mut body = vec![0; length];
                    tls.read_exact(&mut body).await.unwrap();
                    let patch: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(patch["metadata"]["uid"], "same");
                    assert_eq!(patch["metadata"]["resourceVersion"], "1");
                    count.fetch_add(1, Ordering::SeqCst);
                    saved.lock().unwrap()["data"]["value"] = patch["data"]["value"].clone();
                    saved.lock().unwrap()["metadata"]["resourceVersion"] = "2".into();
                    // The mutation happened; the connection closes before any response.
                } else {
                    assert!(header.starts_with("GET "));
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer after")
                    );
                    let body = serde_json::to_vec(&*saved.lock().unwrap()).unwrap();
                    tls.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                    tls.write_all(&body).await.unwrap();
                }
            }
        });
        assert!(
            k8s.patch(&current, &json!({"data":{"value":"committed"}}))
                .await
                .is_err()
        );
        tokio::fs::write(&token, "after").await.unwrap();
        let actual = k8s
            .read("ConfigMap", Some("pgcf-system"), "owned")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual["data"]["value"], "committed");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        task.await.unwrap();
        tokio::fs::remove_file(token).await.unwrap();
    }
}
#[cfg(test)]
mod resize_tests {
    use crate::test_server::{Server, uid};
    use serde_json::json;
    #[tokio::test]
    async fn a_resize_is_a_strategic_merge_of_requests_under_the_pod_uid() {
        let server = Server::start().await;
        server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":"pgcf-db-a","uid":uid(1)},
            "spec":{"containers":[{"name":"postgres","image":"x","resources":{"requests":{"cpu":"25m","memory":"128Mi"},"limits":{"cpu":"250m"}}},{"name":"other","image":"y"}]},"status":{}}));
        let pod = server
            .k8s
            .read("Pod", Some("pgcf-db-a"), "database-1")
            .await
            .unwrap()
            .unwrap();
        let resized = server
            .k8s
            .resize_pod(
                &pod,
                &[("postgres", json!({"cpu":"10m","memory":"96Mi"}))],
                &[],
            )
            .await
            .unwrap();
        let containers = &resized["spec"]["containers"];
        assert_eq!(
            containers[0]["resources"]["requests"],
            json!({"cpu":"10m","memory":"96Mi"})
        );
        assert_eq!(containers[0]["resources"]["limits"], json!({"cpu":"250m"}));
        assert_eq!(containers[1], json!({"name":"other","image":"y"}));
        {
            let state = server.state.lock().unwrap();
            // Only the named containers' requests, under the UID alone: a Pod's resourceVersion
            // churns.
            assert_eq!(
                state.writes[0].2,
                json!({"metadata":{"uid":uid(1)},"spec":{"containers":[{"name":"postgres","resources":{"requests":{"cpu":"10m","memory":"96Mi"}}}]}})
            );
            assert_eq!(
                state.patch_types[0],
                (
                    "/api/v1/namespaces/pgcf-db-a/pods/database-1/resize".to_string(),
                    "application/strategic-merge-patch+json".to_string()
                )
            );
        }
        // Another Pod's identity is refused by the server under the UID precondition; a deleting
        // Pod and a resize of nothing are refused before anything is sent.
        let mut forged = pod.clone();
        forged["metadata"]["uid"] = uid(2).into();
        assert!(
            server
                .k8s
                .resize_pod(&forged, &[("postgres", json!({"cpu":"5m"}))], &[])
                .await
                .is_err()
        );
        let mut deleting = pod.clone();
        deleting["metadata"]["deletionTimestamp"] = "2026-10-15T00:00:00Z".into();
        assert!(
            server
                .k8s
                .resize_pod(&deleting, &[("postgres", json!({"cpu":"5m"}))], &[])
                .await
                .is_err()
        );
        assert!(server.k8s.resize_pod(&pod, &[], &[]).await.is_err());
        assert_eq!(server.state.lock().unwrap().writes.len(), 1);
    }
}
