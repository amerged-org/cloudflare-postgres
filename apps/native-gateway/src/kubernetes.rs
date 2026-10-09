// SPDX-License-Identifier: Apache-2.0
use crate::sessions::{Action, SharedSessions};
use futures_util::StreamExt;
use pgcf_native_protocol::{constant, valid_pattern, valid_schema, wire};
use reqwest::{Client, Url};
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{RwLock, watch};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub database: String,
    pub operation: String,
    pub revision: u64,
    pub mode: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fence {
    pub uid: String,
    pub intent: Intent,
    pub retired_at: Option<u64>,
    pub deleting: bool,
}
#[derive(Default)]
pub struct FenceState {
    pub ready: bool,
    pub epoch: u64,
    pub records: HashMap<String, Fence>,
    pub observed: Option<Instant>,
    database_epochs: HashMap<String, u64>,
    next_database_epoch: u64,
}
impl FenceState {
    pub fn bound_epoch(&self, database: &str) -> (u64, u64) {
        (
            self.epoch,
            *self.database_epochs.get(database).unwrap_or(&0),
        )
    }
    pub fn synchronized(&self) -> bool {
        self.ready
            && self
                .observed
                .is_some_and(|v| v.elapsed() < Duration::from_secs(70))
    }
    pub fn admits(&self, database: &str) -> bool {
        self.synchronized()
            && self
                .records
                .get(database)
                .is_none_or(|v| v.intent.mode == "running")
    }
    pub fn replace(&mut self, records: HashMap<String, Fence>) -> Result<(), &'static str> {
        self.replace_checked(records, |_| false)
    }
    pub fn replace_checked(
        &mut self,
        records: HashMap<String, Fence>,
        can_remove: impl Fn(&Fence) -> bool,
    ) -> Result<(), &'static str> {
        for (database, old) in &self.records {
            let Some(new) = records.get(database) else {
                if can_remove(old) {
                    continue;
                }
                self.ready = false;
                return Err("fence disappeared");
            };
            if new.uid != old.uid
                || new.intent.revision < old.intent.revision
                || (new.intent.revision == old.intent.revision && new.intent != old.intent)
                || (old.intent.mode == "retired" && new.intent != old.intent)
                || (old.intent.mode == "retired" && new.retired_at != old.retired_at)
                || (new.deleting && !(old.intent.mode == "retired" && can_remove(old)))
            {
                self.ready = false;
                return Err("fence identity or history changed");
            }
        }
        if records
            .values()
            .any(|new| new.deleting && !self.records.contains_key(&new.intent.database))
        {
            self.ready = false;
            return Err("unobserved deleting fence");
        }
        for (database, record) in &records {
            if self.records.get(database) != Some(record) {
                self.next_database_epoch += 1;
                self.database_epochs
                    .insert(database.clone(), self.next_database_epoch);
            }
        }
        if !self.ready {
            self.epoch += 1;
        }
        self.database_epochs
            .retain(|database, _| records.contains_key(database));
        self.records = records;
        self.ready = true;
        self.observed = Some(Instant::now());
        Ok(())
    }
    pub fn disconnect(&mut self) {
        self.ready = false;
        self.epoch += 1;
    }
}
#[derive(Clone)]
pub struct Kubernetes {
    client: Client,
    origin: Url,
    token: PathBuf,
    ca_cache: Arc<tokio::sync::Mutex<CaCache>>,
}
struct CachedCa {
    value: Vec<u8>,
    expires: Instant,
    inserted: Instant,
}
type CaOutcome = Result<Vec<u8>, &'static str>;
#[derive(Default)]
struct CaCache {
    entries: HashMap<String, CachedCa>,
    inflight: HashMap<String, watch::Receiver<Option<CaOutcome>>>,
}
impl Kubernetes {
    pub async fn in_cluster() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
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
        let path = PathBuf::from("/var/run/secrets/kubernetes.io/serviceaccount");
        let ca = tokio::fs::read(path.join("ca.crt")).await?;
        let client = client_builder()
            .tls_certs_only([reqwest::Certificate::from_pem(&ca)?])
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            client,
            origin,
            token: path.join("token"),
            ca_cache: Arc::new(tokio::sync::Mutex::new(CaCache::default())),
        })
    }
    async fn read(
        &self,
        path: &str,
        maximum: usize,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let token = tokio::fs::read_to_string(&self.token).await?;
        let response = self
            .client
            .get(self.origin.join(path)?)
            .bearer_auth(token.trim())
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|v| v > maximum as u64)
        {
            return Err("Kubernetes response too large".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part?;
            if part.len() > maximum - bytes.len() {
                return Err("Kubernetes response too large".into());
            }
            bytes.extend_from_slice(&part);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub async fn database_ca(
        &self,
        database: &str,
        refresh: bool,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        if !valid_pattern("database", database) {
            return Err("invalid database identity".into());
        }
        let mut receiver = {
            let mut cache = self.ca_cache.lock().await;
            if !refresh
                && let Some(cached) = cache.entries.get(database)
                && cached.expires > Instant::now()
            {
                return Ok(cached.value.clone());
            }
            if let Some(receiver) = cache.inflight.get(database) {
                receiver.clone()
            } else {
                if cache.inflight.len() >= 2000 {
                    return Err("database CA request capacity exhausted".into());
                }
                let (sender, receiver) = watch::channel(None);
                cache
                    .inflight
                    .insert(database.to_string(), receiver.clone());
                let api = self.clone();
                let database = database.to_string();
                // A cancelled connection cannot cancel the shared bounded GET or
                // strand its in-flight cache slot. No write is retried here.
                tokio::spawn(async move {
                    let outcome = api
                        .fetch_database_ca(&database)
                        .await
                        .map_err(|_| "database CA unavailable");
                    let mut cache = api.ca_cache.lock().await;
                    if let Ok(value) = &outcome {
                        if cache.entries.len() >= 2000
                            && !cache.entries.contains_key(&database)
                            && let Some(oldest) = cache
                                .entries
                                .iter()
                                .min_by_key(|(_, value)| value.inserted)
                                .map(|(name, _)| name.clone())
                        {
                            cache.entries.remove(&oldest);
                        }
                        cache.entries.insert(
                            database.clone(),
                            CachedCa {
                                value: value.clone(),
                                expires: Instant::now() + Duration::from_secs(300),
                                inserted: Instant::now(),
                            },
                        );
                    }
                    cache.inflight.remove(&database);
                    drop(cache);
                    let _ = sender.send(Some(outcome));
                });
                receiver
            }
        };
        loop {
            if let Some(outcome) = receiver.borrow().clone() {
                return outcome.map_err(Into::into);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "database CA unavailable")?;
        }
    }
    async fn fetch_database_ca(
        &self,
        database: &str,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        if !valid_pattern("database", database) {
            return Err("invalid database identity".into());
        }
        let value = self
            .read(
                &format!(
                    "/api/v1/namespaces/{}/configmaps/ca-{database}",
                    wire("fenceNamespace")
                ),
                128 * 1024,
            )
            .await?;
        if value["metadata"]["name"] != format!("ca-{database}")
            || value["metadata"]["namespace"] != wire("fenceNamespace")
        {
            return Err("database CA identity mismatch".into());
        }
        let ca = value["data"]["ca.crt"]
            .as_str()
            .filter(|v| v.len() <= 65_536)
            .ok_or("database CA unavailable")?;
        let certificates =
            CertificateDer::pem_slice_iter(ca.as_bytes()).collect::<Result<Vec<_>, _>>()?;
        if certificates.is_empty() {
            return Err("invalid database CA".into());
        }
        let mut roots = rustls::RootCertStore::empty();
        for certificate in certificates {
            roots.add(certificate)?;
        }
        Ok(ca.as_bytes().to_vec())
    }
    pub(crate) async fn discovery_list(
        &self,
        path: &str,
        selector: &str,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        discovery_path(path, selector)?;
        let mut url = self.origin.join(path)?;
        url.query_pairs_mut().append_pair("labelSelector", selector);
        self.read(
            &format!(
                "{}?{}",
                url.path(),
                url.query().ok_or("missing discovery selector")?
            ),
            4 * 1024 * 1024,
        )
        .await
    }
    pub(crate) async fn discovery_watch(
        &self,
        path: &str,
        selector: &str,
        version: &str,
    ) -> Result<reqwest::Response, Box<dyn std::error::Error + Send + Sync>> {
        discovery_path(path, selector)?;
        if version.is_empty() || version.len() > 128 {
            return Err("invalid discovery version".into());
        }
        let mut url = self.origin.join(path)?;
        url.query_pairs_mut()
            .append_pair("watch", "true")
            .append_pair("allowWatchBookmarks", "true")
            .append_pair("timeoutSeconds", "55")
            .append_pair("labelSelector", selector)
            .append_pair("resourceVersion", version);
        let token = tokio::fs::read_to_string(&self.token).await?;
        Ok(tokio::time::timeout(
            Duration::from_secs(10),
            self.client
                .get(url)
                .bearer_auth(token.trim())
                .timeout(Duration::from_secs(65))
                .send(),
        )
        .await??
        .error_for_status()?)
    }
    async fn fence_list(
        &self,
    ) -> Result<(HashMap<String, Fence>, String), Box<dyn std::error::Error + Send + Sync>> {
        let value = self
            .read(
                &format!(
                    "/api/v1/namespaces/{}/configmaps?labelSelector={}",
                    wire("fenceNamespace"),
                    wire("fenceSelector")
                ),
                4 * 1024 * 1024,
            )
            .await?;
        let records = parse_snapshot(&value)?;
        Ok((
            records,
            value["metadata"]["resourceVersion"]
                .as_str()
                .ok_or("missing fence list version")?
                .to_string(),
        ))
    }
    async fn fence_watch(
        &self,
        version: &str,
    ) -> Result<reqwest::Response, Box<dyn std::error::Error + Send + Sync>> {
        if version.is_empty() || version.len() > 128 {
            return Err("invalid watch version".into());
        }
        let mut url = self.origin.join(&format!(
            "/api/v1/namespaces/{}/configmaps",
            wire("fenceNamespace")
        ))?;
        url.query_pairs_mut()
            .append_pair("watch", "true")
            .append_pair("allowWatchBookmarks", "true")
            .append_pair("timeoutSeconds", "55")
            .append_pair("labelSelector", wire("fenceSelector"))
            .append_pair("resourceVersion", version);
        let token = tokio::fs::read_to_string(&self.token).await?;
        Ok(self
            .client
            .get(url)
            .bearer_auth(token.trim())
            .timeout(Duration::from_secs(65))
            .send()
            .await?
            .error_for_status()?)
    }
}
fn discovery_path(path: &str, selector: &str) -> Result<(), &'static str> {
    if (path == "/apis/discovery.k8s.io/v1/endpointslices"
        && selector == "kubernetes.io/service-name=database-rw")
        || (path == format!("/api/v1/namespaces/{}/configmaps", wire("fenceNamespace"))
            && selector == "pgcf.io/database-id")
    {
        Ok(())
    } else {
        Err("unsupported discovery path")
    }
}
fn client_builder() -> reqwest::ClientBuilder {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
}
pub fn parse_snapshot(value: &Value) -> Result<HashMap<String, Fence>, &'static str> {
    if value["kind"] != "ConfigMapList"
        || value["apiVersion"] != "v1"
        || value["metadata"]["resourceVersion"]
            .as_str()
            .is_none_or(|v| v.is_empty() || v.len() > 128)
    {
        return Err("invalid fence snapshot");
    }
    let items = value["items"]
        .as_array()
        .filter(|v| v.len() <= 2000)
        .ok_or("invalid fence snapshot")?;
    let mut records = HashMap::new();
    for item in items {
        let metadata = &item["metadata"];
        let text = item["data"]["intent.json"]
            .as_str()
            .filter(|v| v.len() <= 1024)
            .ok_or("invalid fence intent")?;
        let intent_value: Value = serde_json::from_str(text).map_err(|_| "invalid fence intent")?;
        if !valid_schema("intent", &intent_value) {
            return Err("invalid fence intent");
        }
        let intent: Intent =
            serde_json::from_value(intent_value).map_err(|_| "invalid fence intent")?;
        if !valid_pattern("database", &intent.database)
            || !valid_pattern("operation", &intent.operation)
            || intent.revision == 0
            || intent.revision > 9_007_199_254_740_991
            || !["quiesce", "running", "retired"].contains(&intent.mode.as_str())
            || item["apiVersion"] != "v1"
            || item["kind"] != "ConfigMap"
            || metadata["namespace"] != wire("fenceNamespace")
            || metadata["name"] != format!("gateway-fence-{}", intent.database)
            || metadata["labels"][wire("fenceLabel")] != "true"
            || metadata["labels"]["pgcf.io/database-id"] != intent.database
            || (metadata.get("deletionTimestamp").is_some() && intent.mode != "retired")
            || metadata["resourceVersion"]
                .as_str()
                .is_none_or(|v| v.is_empty() || v.len() > 128)
        {
            return Err("invalid fence identity");
        }
        let uid = metadata["uid"]
            .as_str()
            .filter(|v| valid_pattern("uuid", v))
            .ok_or("invalid fence UID")?;
        let retired_at = if intent.mode == "retired" {
            let text = item["data"]["retired-at"]
                .as_str()
                .ok_or("invalid retirement time")?;
            let parsed =
                time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| "invalid retirement time")?;
            let millis: u64 = (parsed.unix_timestamp_nanos() / 1_000_000)
                .try_into()
                .map_err(|_| "invalid retirement time")?;
            if crate::control::timestamp(millis) != text || millis > crate::control::now() + 5000 {
                return Err("invalid retirement time");
            }
            Some(millis)
        } else {
            None
        };
        if records
            .insert(
                intent.database.clone(),
                Fence {
                    uid: uid.into(),
                    intent,
                    retired_at,
                    deleting: metadata.get("deletionTimestamp").is_some(),
                },
            )
            .is_some()
        {
            return Err("duplicate fence");
        }
    }
    Ok(records)
}
/// Authenticated list/watch is separate from connection admission and carries no
/// provider dependency. A broken stream or identity/history mismatch fails closed.
pub async fn synchronize(
    api: Arc<Kubernetes>,
    state: Arc<RwLock<FenceState>>,
    sessions: SharedSessions,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        if *stop.borrow() {
            break;
        }
        let list = tokio::select! {
            value=tokio::time::timeout(Duration::from_secs(10),api.fence_list())=>value,
            _=stop.changed()=>break,
        };
        if let Ok(Ok((records, version))) = list
            && apply_records(&state, &sessions, records).await.is_ok()
            && watch_session(&api, &state, &sessions, &version, &mut stop)
                .await
                .is_ok()
        {
            continue;
        }
        state.write().await.disconnect();
        if *stop.borrow() {
            break;
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(1))=>{}, _=stop.changed()=>break }
    }
    state.write().await.disconnect();
}
async fn apply_records(
    state: &RwLock<FenceState>,
    sessions: &SharedSessions,
    records: HashMap<String, Fence>,
) -> Result<(), &'static str> {
    let mut current = state.write().await;
    let owned = sessions.lock().unwrap();
    let previous = current.records.clone();
    current.replace_checked(records, |record| {
        retirement_ready(record, owned.counts(&record.intent.database).connections)
    })?;
    for fence in current.records.values() {
        if previous
            .get(&fence.intent.database)
            .is_none_or(|old| old.intent != fence.intent)
        {
            owned.signal(
                &fence.intent.database,
                match fence.intent.mode.as_str() {
                    "quiesce" => Action::Quiesce,
                    "retired" => Action::Retire,
                    _ => Action::Running,
                },
            );
        }
    }
    Ok(())
}
async fn watch_session(
    api: &Kubernetes,
    state: &RwLock<FenceState>,
    sessions: &SharedSessions,
    version: &str,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let response = tokio::select! {
        response=tokio::time::timeout(Duration::from_secs(10),api.fence_watch(version))=>response??,
        _=stop.changed()=>return Ok(()),
    };
    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut line = Vec::new();
    loop {
        let next = tokio::select! {
            next=tokio::time::timeout(Duration::from_secs(60),stream.next())=>next?,
            _=stop.changed()=>return Ok(()),
        };
        let Some(part) = next else {
            if !line.is_empty() {
                return Err("truncated fence watch event".into());
            }
            if started.elapsed() < Duration::from_secs(50) {
                return Err("fence watch ended early".into());
            }
            return Ok(());
        };
        for byte in part? {
            if byte == b'\n' {
                if !line.is_empty() {
                    let event: Value = serde_json::from_slice(&line)?;
                    apply_watch_event(state, sessions, &event).await?;
                    line.clear();
                }
            } else {
                if line.len() >= 64 * 1024 {
                    return Err("fence watch event too large".into());
                }
                line.push(byte);
            }
        }
    }
}
async fn apply_watch_event(
    state: &RwLock<FenceState>,
    sessions: &SharedSessions,
    event: &Value,
) -> Result<(), &'static str> {
    let version = event["object"]["metadata"]["resourceVersion"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or("invalid fence watch version")?;
    if event["type"] == "BOOKMARK" {
        state.write().await.observed = Some(Instant::now());
        return Ok(());
    }
    if !["ADDED", "MODIFIED", "DELETED"]
        .iter()
        .any(|kind| event["type"] == *kind)
    {
        return Err("invalid fence watch type");
    }
    let list = serde_json::json!({"apiVersion":"v1","kind":"ConfigMapList","metadata":{"resourceVersion":version},"items":[event["object"]]});
    let record = parse_snapshot(&list)?
        .into_values()
        .next()
        .ok_or("empty watch event")?;
    let mut records = state.read().await.records.clone();
    if event["type"] == "DELETED" {
        let old = records
            .get(&record.intent.database)
            .ok_or("unobserved retired fence deletion")?;
        if old.uid != record.uid
            || old.intent != record.intent
            || old.retired_at != record.retired_at
            || !retirement_ready(
                old,
                sessions
                    .lock()
                    .unwrap()
                    .counts(&record.intent.database)
                    .connections,
            )
        {
            return Err("retirement deletion identity mismatch");
        }
        records.remove(&record.intent.database);
    } else {
        records.insert(record.intent.database.clone(), record);
    }
    apply_records(state, sessions, records).await
}
pub fn retirement_ready(fence: &Fence, connections: usize) -> bool {
    fence.intent.mode == "retired"
        && connections == 0
        && fence.retired_at.is_some_and(|at| {
            crate::control::now().saturating_sub(at) >= constant("GATEWAY_RETIRE_HOLD_MS")
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::Sessions;
    use serde_json::json;
    fn object(database: &str, mode: &str, revision: u64) -> Value {
        let mut data = json!({"intent.json":json!({"database":database,"operation":format!("op_{}","b".repeat(20)),"revision":revision,"mode":mode}).to_string()});
        if mode == "retired" {
            data["retired-at"] = json!(crate::control::timestamp(crate::control::now() - 65_001));
        }
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"namespace":"pgcf-system","name":format!("gateway-fence-{database}"),"uid":"01234567-89ab-4def-8123-0123456789ab","resourceVersion":revision.to_string(),"labels":{"pgcf.io/gateway-fence":"true","pgcf.io/database-id":database}},"data":data})
    }
    #[tokio::test]
    async fn watch_updates_only_the_bound_database_epoch_and_requires_retirement_hold_for_deletion()
    {
        let database = "a".repeat(20);
        let state = RwLock::new(FenceState::default());
        let sessions = Arc::new(std::sync::Mutex::new(Sessions::default()));
        apply_watch_event(
            &state,
            &sessions,
            &json!({"type":"ADDED","object":object(&database,"running",1)}),
        )
        .await
        .unwrap();
        let expected = state.read().await.bound_epoch(&database);
        apply_watch_event(
            &state,
            &sessions,
            &json!({"type":"ADDED","object":object(&"c".repeat(20),"quiesce",1)}),
        )
        .await
        .unwrap();
        assert_eq!(state.read().await.bound_epoch(&database), expected);
        apply_watch_event(
            &state,
            &sessions,
            &json!({"type":"MODIFIED","object":object(&database,"quiesce",2)}),
        )
        .await
        .unwrap();
        assert!(!state.read().await.admits(&database));
        assert_ne!(state.read().await.bound_epoch(&database), expected);
        let retired = object(&database, "retired", 3);
        apply_watch_event(
            &state,
            &sessions,
            &json!({"type":"MODIFIED","object":retired}),
        )
        .await
        .unwrap();
        apply_watch_event(
            &state,
            &sessions,
            &json!({"type":"DELETED","object":retired}),
        )
        .await
        .unwrap();
        assert!(!state.read().await.records.contains_key(&database));
        assert!(
            apply_watch_event(
                &state,
                &sessions,
                &json!({"type":"DELETED","object":object(&"c".repeat(20),"quiesce",1)})
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn cancelled_ca_consumers_do_not_cancel_the_shared_get_or_leak_its_slot() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
            sync::{Notify, oneshot},
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let arrived = Arc::new(Notify::new());
        let (release, wait) = oneshot::channel();
        let ca = rcgen::generate_simple_self_signed(vec!["database.example".into()])
            .unwrap()
            .cert
            .pem();
        let served_ca = ca.clone();
        let count = calls.clone();
        let received = arrived.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut bytes = [0; 2048];
            while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                let n = socket.read(&mut bytes).await.unwrap();
                if n == 0 {
                    return;
                }
                request.extend_from_slice(&bytes[..n]);
            }
            assert!(
                String::from_utf8_lossy(&request)
                    .to_ascii_lowercase()
                    .contains("authorization: bearer unit-fixture-token")
            );
            count.fetch_add(1, Ordering::SeqCst);
            received.notify_one();
            let _ = wait.await;
            let body=json!({"metadata":{"name":format!("ca-{}","a".repeat(20)),"namespace":"pgcf-system"},"data":{"ca.crt":served_ca}}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        struct File(std::path::PathBuf);
        impl Drop for File {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let token = File(std::env::temp_dir().join(format!(
            "pgcf-ca-consumer-test-{}-{}",
            std::process::id(),
            crate::control::now()
        )));
        std::fs::write(&token.0, "unit-fixture-token").unwrap();
        let api = Arc::new(Kubernetes {
            client: client_builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            origin: Url::parse(&format!("http://{address}")).unwrap(),
            token: token.0.clone(),
            ca_cache: Arc::new(tokio::sync::Mutex::new(CaCache::default())),
        });
        let first = api.clone();
        let request = tokio::spawn(async move { first.database_ca(&"a".repeat(20), false).await });
        arrived.notified().await;
        let second = api.clone();
        let other = tokio::spawn(async move { second.database_ca(&"a".repeat(20), true).await });
        tokio::task::yield_now().await;
        request.abort();
        other.abort();
        let _ = request.await;
        let _ = other.await;
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if api.ca_cache.lock().await.inflight.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            api.database_ca(&"a".repeat(20), false).await.unwrap(),
            ca.as_bytes()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.await.unwrap();
    }
}
