// SPDX-License-Identifier: Apache-2.0
use crate::{Error, contracts::text};
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::{Client, Method, StatusCode, Url};
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
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
/// How long the version of this controller's own write is remembered for the event of the watch
/// that is still to come; a watch that restarted past it never delivers it.
const OWN_WRITE_MEMORY: Duration = Duration::from_secs(120);
/// How many reads of one group are in flight at once: the group of a pass is a dozen objects and
/// the API server answers each in a few milliseconds.
const READ_FANOUT: usize = 8;
/// Versions remembered for one object: a pass writes one object a few times at most.
const OWN_WRITES_PER_OBJECT: usize = 16;
#[derive(Debug)]
struct WatchContinuity {
    controller_epoch: String,
    epoch: u64,
    kinds: HashMap<String, (String, Instant, bool)>,
    objects: HashMap<(String, String, String), (String, String)>,
    /// Versions of watched objects that this controller itself wrote and whose watch events have
    /// not arrived yet, by (kind, namespace, name): the pass that wrote one holds the object as
    /// written, so its event is not a change someone else made.
    written: HashMap<(String, String, String), Vec<(String, Instant)>>,
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
        }
    }
}
impl WatchContinuity {
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
        } else {
            if self.objects.len() >= 4096 && !self.objects.contains_key(&key) {
                return false;
            }
            self.objects.insert(key, (uid.into(), rv.into()));
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
        self.kinds
            .get(kind)
            .is_some_and(|(_, at, live)| *live && at.elapsed() < Duration::from_secs(70))
            && self.objects.get(&key).is_some_and(|(uid, version)| {
                Some(uid.as_str()) == meta["uid"].as_str()
                    && Some(version.as_str()) == meta["resourceVersion"].as_str()
            })
    }
    fn gap(&mut self, kind: &str) {
        self.epoch += 1;
        self.kinds.remove(kind);
        self.objects.retain(|(resource, _, _), _| resource != kind);
    }
    fn snapshot(&self) -> Option<(String, u64)> {
        RUNTIME_WATCH_KINDS
            .iter()
            .all(|kind| {
                self.kinds
                    .get(*kind)
                    .is_some_and(|(_, at, live)| *live && at.elapsed() < Duration::from_secs(70))
            })
            .then(|| (self.controller_epoch.clone(), self.epoch))
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
        let key = (
            kind.to_string(),
            text(meta, "namespace").to_string(),
            text(meta, "name").to_string(),
        );
        let version = text(meta, "resourceVersion");
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
    /// what the event hints for reconciliation, a database ID or a pool scope. The event of a
    /// version this controller wrote itself hints no database: the pass that wrote it holds the
    /// object as written, and a change someone else makes has a version of its own.
    fn event(&mut self, kind: &str, event: &Value) -> Result<(String, Option<String>), Error> {
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
        if !self.observe(kind, object, event_type == "DELETED") {
            return Err("watch object metadata invalid".into());
        }
        let meta = &object["metadata"];
        let labelled = text(&meta["labels"], "pgcf.io/database-id");
        let id = if labelled.is_empty() {
            text(meta, "namespace")
                .strip_prefix("pgcf-db-")
                .unwrap_or("")
        } else {
            labelled
        };
        let hint = if pgcf_native_protocol::valid_pattern("database", id) {
            (!self.own(kind, object)).then(|| id.to_string())
        } else {
            let prefix = match kind {
                "Pod" if meta["namespace"] == "pgcf-pool" => Some("pool-pod:"),
                "Namespace" if meta["name"] == "pgcf-pool" => Some("pool-namespace:"),
                "Node" => Some("pool-node:"),
                _ => None,
            };
            prefix.and_then(|prefix| {
                let uid = text(meta, "uid");
                pgcf_native_protocol::valid_pattern("uuid", uid).then(|| format!("{prefix}{uid}"))
            })
        };
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
        "Lease" => ("/apis/coordination.k8s.io/v1", "leases", false),
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
        "LVMSnapshot" => ("/apis/local.openebs.io/v1alpha1", "lvmsnapshots", false),
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
    pub fn runtime_continuity(&self) -> Option<(String, u64)> {
        self.continuity.lock().unwrap().snapshot()
    }
    /// What one event of a metadata watch of `kind` makes of the watch: the revision it stands at
    /// and the database or pool scope it hints. An event for a version this controller wrote
    /// itself hints no database.
    pub(crate) fn watch_event(
        &self,
        kind: &str,
        event: &Value,
    ) -> Result<(String, Option<String>), Error> {
        self.continuity.lock().unwrap().event(kind, event)
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
        if proof["kind"] == "pool"
            && !state.objects.iter().any(|((kind, _, _), (uid, version))| {
                kind == "Namespace"
                    && Some(uid.as_str()) == proof["pool_namespace_uid"].as_str()
                    && Some(version.as_str()) == proof["pool_namespace_resource_version"].as_str()
            })
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
            state
                .objects
                .iter()
                .any(|((resource, _, _), (actual, rv))| {
                    resource == kind
                        && Some(actual.as_str()) == proof[*uid].as_str()
                        && Some(rv.as_str())
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
        for kind in RUNTIME_WATCH_KINDS {
            state.connected(kind, "1");
        }
        for object in objects {
            if let Some(kind) = object["kind"]
                .as_str()
                .filter(|kind| RUNTIME_WATCH_KINDS.contains(kind))
            {
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
        events: tokio::sync::mpsc::Sender<String>,
    ) -> Result<(), Error> {
        if !RUNTIME_WATCH_KINDS.contains(&kind) {
            return Err("unsupported controller watch".into());
        }
        let _guard = WatchGuard {
            state: self.continuity.clone(),
            kind: kind.into(),
        };
        let path = collection(kind, None)?;
        let mut url = self.origin.join(&path)?;
        url.query_pairs_mut().append_pair("limit", "512");
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
        let initial: Value = serde_json::from_slice(&bounded(response, 2 * 1024 * 1024).await?)?;
        let mut version = text(&initial["metadata"], "resourceVersion").to_string();
        let items = initial["items"]
            .as_array()
            .filter(|items| items.len() <= 512)
            .ok_or("watch baseline incomplete")?;
        if version.is_empty()
            || version.len() > 128
            || !text(&initial["metadata"], "continue").is_empty()
        {
            return Err("watch baseline incomplete or missing revision".into());
        }
        for item in items {
            if !self.continuity.lock().unwrap().observe(kind, item, false) {
                return Err("watch baseline metadata invalid".into());
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
            let mut pending = Vec::new();
            while let Some(bytes) = stream.next().await {
                let bytes = bytes?;
                if bytes.len() > 1024 * 1024 - pending.len() {
                    return Err("Kubernetes watch frame exceeds bound".into());
                }
                pending.extend_from_slice(&bytes);
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = pending.drain(..=end).collect();
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    let event: Value = serde_json::from_slice(&line)?;
                    let (next, hint) = self.watch_event(kind, &event)?;
                    version = next;
                    if let Some(hint) = hint {
                        events
                            .try_send(hint)
                            .map_err(|_| "controller hint queue exhausted")?;
                    }
                }
            }
            if !pending.is_empty() {
                return Err("Kubernetes watch frame was interrupted".into());
            }
            if let Some(kind) = self.continuity.lock().unwrap().kinds.get_mut(kind) {
                kind.2 = false;
            }
        }
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
    pub async fn read(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        let value = self
            .request(Method::GET, &named(kind, namespace, name)?, None)
            .await?;
        if value
            .as_ref()
            .is_some_and(|v| !is_object(v, kind, namespace, name))
        {
            return Err("Kubernetes read identity changed".into());
        }
        Ok(value)
    }
    /// Reads `objects` (kind, namespace, name) a few at a time and answers them in the order they
    /// were asked in. They are independent reads: the answers are as of the same moment only to
    /// the extent that any run of reads is. A slow read holds back no other.
    pub async fn read_all(
        &self,
        objects: &[(&str, Option<&str>, &str)],
    ) -> Result<Vec<Option<Value>>, Error> {
        let mut answered: Vec<(usize, Option<Value>)> = stream::iter(objects.iter().enumerate())
            .map(|(index, (kind, namespace, name))| async move {
                Ok::<_, Error>((index, self.read(kind, *namespace, name).await?))
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
                query.append_pair("limit", "200");
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
        self.continuity.lock().unwrap().wrote(kind, &result, rv);
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
        self.continuity.lock().unwrap().wrote(
            "Pod",
            &result,
            text(&pod["metadata"], "resourceVersion"),
        );
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
    /// Bounded logs from the exact current OpenEBS driver container, with identity brackets.
    pub async fn openebs_driver_logs(
        &self,
        pod: &Value,
        container: &str,
        image: &str,
        since: u64,
    ) -> Result<String, Error> {
        fn identity(pod: &Value, container: &str, image: &str) -> Result<Value, Error> {
            let digest = image
                .split_once("@sha256:")
                .map(|(_, d)| d)
                .filter(|d| {
                    d.len() == 64
                        && d.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or("qualification driver digest unavailable")?;
            let specs = pod["spec"]["containers"]
                .as_array()
                .ok_or("qualification driver container missing")?
                .iter()
                .filter(|c| c["name"] == container && c["image"] == image)
                .collect::<Vec<_>>();
            let statuses = pod["status"]["containerStatuses"]
                .as_array()
                .ok_or("qualification driver status missing")?
                .iter()
                .filter(|c| c["name"] == container)
                .collect::<Vec<_>>();
            if pod["kind"] != "Pod"
                || pod["metadata"]["namespace"] != "openebs"
                || !pod["metadata"]["deletionTimestamp"].is_null()
                || pod["status"]["phase"] != "Running"
                || specs.len() != 1
                || statuses.len() != 1
                || statuses[0]["ready"] != true
                || !statuses[0]["state"]["running"].is_object()
                || !statuses[0]["imageID"].as_str().is_some_and(|id| {
                    id == format!("sha256:{digest}")
                        || id == format!("containerd://sha256:{digest}")
                        || id.ends_with(&format!("@sha256:{digest}"))
                })
                || !pgcf_native_protocol::valid_pattern("uuid", text(&pod["metadata"], "uid"))
                || statuses[0]["containerID"]
                    .as_str()
                    .is_none_or(str::is_empty)
            {
                return Err("qualification driver log identity changed".into());
            }
            Ok(
                serde_json::json!({"uid":pod["metadata"]["uid"],"container":statuses[0]["containerID"],"restarts":statuses[0]["restartCount"],"image":statuses[0]["imageID"]}),
            )
        }
        let name = text(&pod["metadata"], "name");
        if !identifier(name) || !identifier(container) || container.len() > 63 {
            return Err("qualification driver log selector invalid".into());
        }
        let expected = identity(pod, container, image)?;
        let before = self
            .read("Pod", Some("openebs"), name)
            .await?
            .ok_or("qualification driver absent")?;
        if identity(&before, container, image)? != expected {
            return Err("qualification driver changed before logs".into());
        }
        let stamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(since) * 1_000_000)?
            .format(&time::format_description::well_known::Rfc3339)?;
        let token = tokio::fs::read_to_string(&self.token).await?;
        if token.trim().is_empty() {
            return Err("Kubernetes bearer missing".into());
        }
        let mut url = self
            .origin
            .join(&format!("/api/v1/namespaces/openebs/pods/{name}/log"))?;
        url.query_pairs_mut().extend_pairs([
            ("container", container),
            ("sinceTime", stamp.as_str()),
            ("timestamps", "true"),
            ("follow", "false"),
            ("limitBytes", "262144"),
        ]);
        let response = self
            .client
            .get(url)
            .bearer_auth(token.trim())
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        if response.status() != StatusCode::OK {
            return Err("qualification driver logs unavailable".into());
        }
        let raw = String::from_utf8(bounded(response, 262144).await?)?;
        let after = self
            .read("Pod", Some("openebs"), name)
            .await?
            .ok_or("qualification driver absent")?;
        if identity(&after, container, image)? != expected {
            return Err("qualification driver changed during logs".into());
        }
        Ok(raw)
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
        let cluster = self.read("Namespace", None, "kube-system").await?;
        Self::cluster_is(cluster.as_ref(), uid)
    }
    /// Whether `kube_system`, the namespace the identity of a cluster is, is the cluster `uid`.
    pub fn cluster_is(kube_system: Option<&Value>, uid: &str) -> Result<(), Error> {
        let cluster = kube_system.ok_or("cluster identity missing")?;
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
    fn qualification_snapshot_uses_the_pinned_namespaced_resource() {
        assert_eq!(
            named("LVMSnapshot", Some("openebs"), "pgcf-q-owned").unwrap(),
            "/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmsnapshots/pgcf-q-owned"
        );
    }
    #[test]
    fn pool_namespace_watch_loss_invalidates_only_its_actual_runtime_proof() {
        let identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let kube = Kubernetes::with_ca(
            Url::parse("https://localhost/").unwrap(),
            identity.cert.pem().as_bytes(),
            PathBuf::from("unused-runtime-proof-token"),
        )
        .unwrap();
        let mut proof = serde_json::json!({"kind":"pool","pool_namespace_uid":"00000000-0000-4000-8000-000000000009","pool_namespace_resource_version":"7","observation":{"expires_at":u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()+1000,"resource_versions":{}}});
        let pool_namespace = serde_json::json!({"metadata":{"name":"pgcf-pool","uid":proof["pool_namespace_uid"],"resourceVersion":"7"}});
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
            assert!(state.observe("Namespace", &pool_namespace, false));
            proof["observation"]["controller_epoch"] = state.controller_epoch.clone().into();
            proof["observation"]["watch_epoch"] = state.epoch.into();
        }
        assert!(kube.runtime_proof_current(&proof));
        kube.continuity
            .lock()
            .unwrap()
            .observe("Namespace", &pool_namespace, true);
        assert!(
            !kube.runtime_proof_current(&proof),
            "the pool Pod event may lag its namespace deletion"
        );
        proof.as_object_mut().unwrap().remove("kind");
        assert!(
            kube.runtime_proof_current(&proof),
            "CNPG still checks its own tenant namespace"
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
    #[tokio::test]
    async fn the_event_of_a_version_the_controller_wrote_hints_nothing_and_any_other_does() {
        use crate::test_server::{Server, uid};
        let server = Server::start().await;
        let id = "dbbbbbbbbbbbbbbbbbbb";
        let name = format!("gateway-fence-{id}");
        server.put(serde_json::json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":"pgcf-system","uid":uid(1),"labels":{"pgcf.io/database-id":id}},"data":{"power.json":"1"}}));
        let current = server
            .k8s
            .read("ConfigMap", Some("pgcf-system"), &name)
            .await
            .unwrap()
            .unwrap();
        let written = server
            .k8s
            .patch(&current, &serde_json::json!({"data":{"power.json":"2"}}))
            .await
            .unwrap();
        let events = std::mem::take(&mut server.state.lock().unwrap().events);
        assert_eq!(events.len(), 1);
        let (version, hint) = server.k8s.watch_event("ConfigMap", &events[0].1).unwrap();
        assert_eq!(version, written["metadata"]["resourceVersion"]);
        assert_eq!(hint, None, "the write of this controller is not news");
        // Someone else writes the same object next: a version of its own, and a hint. The
        // memory of the controller's write ended with its event.
        let mut other = events[0].1.clone();
        other["object"]["metadata"]["resourceVersion"] = "9".into();
        assert_eq!(
            server.k8s.watch_event("ConfigMap", &other).unwrap(),
            ("9".to_string(), Some(id.to_string()))
        );
        assert_eq!(
            server.k8s.watch_event("ConfigMap", &events[0].1).unwrap().1,
            Some(id.to_string())
        );
        // A write that changed nothing answers the version it was made over, leaves no event
        // and is not remembered.
        let version = written["metadata"]["resourceVersion"].as_str().unwrap();
        server
            .k8s
            .continuity
            .lock()
            .unwrap()
            .wrote("ConfigMap", &written, version);
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
