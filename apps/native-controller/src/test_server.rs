// SPDX-License-Identifier: Apache-2.0
//! In-process HTTPS Kubernetes API double for controller tests. It serves stored objects, lists
//! and text bodies, creates by POST, applies merge patches and deletes only under the request's
//! UID and resourceVersion preconditions, and can drop the reply of one committed write.
//! A plain-HTTP Cloudflare API double answers the controller's agent requests.
use crate::{
    api::ControlApi,
    kubernetes::{Kubernetes, named},
};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

type LoseReply = Box<dyn Fn(&str, &Value) -> bool + Send>;
type RefuseWrite = Box<dyn Fn(&str, &Value) -> Option<u16> + Send>;
type DuringText = Box<dyn FnOnce(&mut BTreeMap<String, Value>) + Send>;
#[derive(Default)]
pub struct State {
    pub objects: BTreeMap<String, Value>,
    pub texts: BTreeMap<String, String>,
    /// Every accepted write as (method, path, request body).
    pub writes: Vec<(String, String, Value)>,
    /// Every request the double received, writes and reads, in the order it was received, as
    /// (method, path).
    pub requests: Vec<(String, String)>,
    /// The query string of every request in `requests`, at the same index (`""` for none).
    pub queries: Vec<String>,
    /// The watch event of every committed write as the API server sends it to a metadata watch of
    /// the object's kind, with that kind: what the controller's own writes make its watches
    /// deliver.
    pub events: Vec<(String, Value)>,
    /// The Content-Type of every PATCH, in the order of `writes`' PATCH entries: (path, type).
    pub patch_types: Vec<(String, String)>,
    /// A write for which this returns a status is refused with it and never committed.
    pub refuse: Option<RefuseWrite>,
    /// Every committed write as one line, appended to a log other doubles also write to, so a
    /// test can assert the order of effects across the cluster, the gateway and PostgreSQL.
    pub log: Option<Arc<Mutex<Vec<String>>>>,
    /// The first committed PATCH or DELETE matching (path, body) closes the connection without a
    /// reply.
    pub lose: Option<LoseReply>,
    /// Runs once while a text body is served, e.g. to replace an object during a scrape.
    pub during_text: Option<DuringText>,
    /// The controller's watch cache, kept equal to `objects` after every change when set (a watch
    /// without lag): the runtime proof of an admitted database needs complete watch coverage.
    pub watch: Option<Kubernetes>,
    /// How long the server holds the answer of a write after it committed it, and queued its
    /// event to the watches: the answer trails the event, as it may on a real API server.
    pub write_reply_delay: Option<Duration>,
    /// The open metadata watches: the collection each is of and the events it has yet to send.
    pub streams: Vec<(String, VecDeque<Value>)>,
    serial: u64,
}
impl State {
    /// Brings the watch cache, if there is one, to the objects as they are now.
    pub fn sync(&self) {
        if let Some(watch) = &self.watch {
            watch.mirror(self.objects.values());
        }
    }
}
pub struct Server {
    pub k8s: Kubernetes,
    pub state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
    token: PathBuf,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.token);
    }
}
pub fn uid(n: u64) -> String {
    format!("01234567-89ab-4def-8123-{n:012x}")
}
pub fn path(kind: &str, namespace: Option<&str>, name: &str) -> String {
    named(kind, namespace, name).unwrap()
}
fn merge(value: &mut Value, patch: &Value) {
    if let Some(object) = patch.as_object() {
        if !value.is_object() {
            *value = json!({});
        }
        for (key, new) in object {
            if new.is_null() {
                value.as_object_mut().unwrap().remove(key);
            } else {
                merge(&mut value[key], new);
            }
        }
    } else {
        *value = patch.clone();
    }
}
/// The defaults the API server writes into a CNPG Cluster from its CRD's structural schema: each
/// managed role is `present`, inherits and has no connection limit unless it says otherwise.
fn defaulted(value: &mut Value) {
    if value["kind"] != "Cluster" {
        return;
    }
    if let Some(roles) = value["spec"]["managed"]["roles"].as_array_mut() {
        for role in roles.iter_mut().filter_map(Value::as_object_mut) {
            role.entry("ensure").or_insert_with(|| "present".into());
            role.entry("inherit").or_insert_with(|| true.into());
            role.entry("connectionLimit").or_insert_with(|| (-1).into());
        }
    }
}
fn collection(path: &str) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let rest = match parts.first() {
        Some(&"api") if parts.len() > 2 => &parts[2..],
        Some(&"apis") if parts.len() > 3 => &parts[3..],
        _ => return false,
    };
    rest.len() == 1 || (rest.len() == 3 && rest[0] == "namespaces")
}
/// kube-apiserver omits TypeMeta on items of built-in lists; custom resources keep theirs.
fn builtin(path: &str) -> bool {
    path.starts_with("/api/")
        || path
            .strip_prefix("/apis/")
            .and_then(|rest| rest.split('/').next())
            .is_some_and(|group| !group.contains('.') || group.ends_with(".k8s.io"))
}
fn listed(key: &str, path: &str) -> bool {
    let Some((parent, _)) = key.rsplit_once('/') else {
        return false;
    };
    let mut parts: Vec<_> = parent.split('/').collect();
    if parent == path {
        return true;
    }
    // A cluster-wide list of a namespaced kind includes every namespace's objects.
    parts.len() > 3 && parts[parts.len() - 3] == "namespaces" && {
        let end = parts.len() - 1;
        parts.drain(end - 2..end);
        parts.join("/") == path
    }
}
/// Strategic merge of the lists the Pod resize subresource edits: named containers merge by name.
fn strategic_merge(value: &mut Value, patch: &Value) {
    match (value.is_array(), patch.as_array()) {
        (true, Some(items)) if items.iter().all(|item| item["name"].is_string()) => {
            for item in items {
                let existing = value
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|v| v["name"] == item["name"]);
                match existing {
                    Some(current) => strategic_merge(current, item),
                    None => value.as_array_mut().unwrap().push(item.clone()),
                }
            }
        }
        _ => {
            if let Some(object) = patch.as_object() {
                if !value.is_object() {
                    *value = json!({});
                }
                for (key, new) in object {
                    if new.is_null() {
                        value.as_object_mut().unwrap().remove(key);
                    } else {
                        strategic_merge(&mut value[key], new);
                    }
                }
            } else {
                *value = patch.clone();
            }
        }
    }
}
/// The value of the query parameter `name`, as the controller writes it (no escapes needed for
/// the numbers and tokens the double reads).
fn parameter<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .find_map(|part| part.strip_prefix(name)?.strip_prefix('='))
}
fn handle(
    state: &mut State,
    method: &str,
    path: &str,
    query: &str,
    body: &[u8],
) -> Option<(u16, Vec<u8>)> {
    let reply = |status: u16, value: &Value| Some((status, serde_json::to_vec(value).unwrap()));
    if matches!(method, "POST" | "PATCH" | "DELETE") {
        let sent: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        if let Some(status) = state.refuse.as_ref().and_then(|refuse| refuse(path, &sent)) {
            return reply(status, &json!({"reason":"Refused"}));
        }
    }
    match method {
        "GET" => {
            if let Some(text) = state.texts.get(path).cloned() {
                if let Some(during) = state.during_text.take() {
                    during(&mut state.objects);
                }
                return Some((200, text.into_bytes()));
            }
            if let Some(value) = state.objects.get(path) {
                return reply(200, value);
            }
            if collection(path) {
                let items: Vec<_> = state
                    .objects
                    .iter()
                    .filter(|(key, _)| listed(key, path))
                    .map(|(_, value)| {
                        let mut value = value.clone();
                        if builtin(path) {
                            let object = value.as_object_mut().unwrap();
                            object.remove("kind");
                            object.remove("apiVersion");
                        }
                        value
                    })
                    .collect();
                // A list is paged as the API server pages it: `limit` items from where the
                // `continue` token (here the offset) says, and the token of the next page.
                let from: usize = parameter(query, "continue")
                    .and_then(|token| token.parse().ok())
                    .unwrap_or(0);
                let limit: usize = parameter(query, "limit")
                    .and_then(|limit| limit.parse().ok())
                    .unwrap_or(usize::MAX);
                let end = from.saturating_add(limit).min(items.len());
                let mut metadata = json!({"resourceVersion":"1"});
                if end < items.len() {
                    metadata["continue"] = end.to_string().into();
                }
                return reply(
                    200,
                    &json!({"kind":"List","metadata":metadata,"items":items[from.min(items.len())..end]}),
                );
            }
            reply(404, &json!({}))
        }
        "POST" => {
            let mut value: Value = serde_json::from_slice(body).unwrap();
            let key = format!("{path}/{}", value["metadata"]["name"].as_str().unwrap());
            if state.objects.contains_key(&key) {
                return reply(409, &json!({"reason":"AlreadyExists"}));
            }
            state.serial += 1;
            value["metadata"]["uid"] = uid(1000 + state.serial).into();
            value["metadata"]["resourceVersion"] = "1".into();
            defaulted(&mut value);
            state.objects.insert(key.clone(), value.clone());
            queue_event(state, "ADDED", &value);
            state.writes.push((method.into(), key, value.clone()));
            reply(201, &value)
        }
        "PATCH" if path.ends_with("/resize") => {
            // The Pod resize subresource: a strategic merge under a UID precondition only.
            let patch: Value = serde_json::from_slice(body).unwrap();
            let target = path.trim_end_matches("/resize");
            let Some(mut current) = state.objects.get(target).cloned() else {
                return reply(404, &json!({}));
            };
            if patch["metadata"]["uid"] != current["metadata"]["uid"] {
                return reply(409, &json!({"reason":"Conflict"}));
            }
            strategic_merge(&mut current, &patch);
            let conditions: Vec<Value> = current["status"]["conditions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|c| c["type"] != "PodResizePending" && c["type"] != "PodResizeInProgress")
                .collect();
            current["status"]["conditions"] = conditions.into();
            // The kubelet actuates an accepted resize at once: what the containers' statuses
            // report follows the new requests.
            for (spec, status) in [
                ("containers", "containerStatuses"),
                ("initContainers", "initContainerStatuses"),
            ] {
                for container in patch["spec"][spec].as_array().into_iter().flatten() {
                    let requests = container["resources"]["requests"].clone();
                    let seen = current["status"][status]
                        .as_array_mut()
                        .and_then(|all| all.iter_mut().find(|s| s["name"] == container["name"]));
                    if let Some(seen) = seen {
                        seen["resources"] = json!({"requests":requests});
                        seen["allocatedResources"] = requests;
                    }
                }
            }
            advance(&mut current);
            state.objects.insert(target.into(), current.clone());
            queue_event(state, "MODIFIED", &current);
            committed(state, method, path, patch, &current)
        }
        "PATCH" => {
            let patch: Value = serde_json::from_slice(body).unwrap();
            let Some(mut current) = state.objects.get(path).cloned() else {
                return reply(404, &json!({}));
            };
            if patch["metadata"]["uid"] != current["metadata"]["uid"]
                || patch["metadata"]["resourceVersion"] != current["metadata"]["resourceVersion"]
            {
                return reply(409, &json!({"reason":"Conflict"}));
            }
            merge(&mut current, &patch);
            defaulted(&mut current);
            advance(&mut current);
            state.objects.insert(path.into(), current.clone());
            queue_event(state, "MODIFIED", &current);
            committed(state, method, path, patch, &current)
        }
        "DELETE" => {
            let options: Value = serde_json::from_slice(body).unwrap();
            let Some(mut current) = state.objects.get(path).cloned() else {
                return reply(404, &json!({}));
            };
            let preconditions = &options["preconditions"];
            if preconditions["uid"] != current["metadata"]["uid"]
                || preconditions["resourceVersion"] != current["metadata"]["resourceVersion"]
            {
                return reply(409, &json!({"reason":"Conflict"}));
            }
            // A Pod terminates gracefully under its deletionTimestamp; other kinds go at once.
            if current["kind"] == "Pod" {
                current["metadata"]["deletionTimestamp"] = "2026-10-11T00:00:00Z".into();
                advance(&mut current);
                state.objects.insert(path.into(), current.clone());
                queue_event(state, "MODIFIED", &current);
            } else {
                state.objects.remove(path);
                queue_event(state, "DELETED", &current);
            }
            committed(state, method, path, options, &current)
        }
        _ => reply(405, &json!({})),
    }
}
/// Queues the watch event of a committed write of `object`, which a metadata watch of its kind
/// receives.
fn queue_event(state: &mut State, kind: &str, object: &Value) {
    let event = json!({"type":kind,"object":{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":object["metadata"].clone()}});
    let kind = object["kind"].as_str().unwrap_or_default().to_string();
    if let Some(name) = object["metadata"]["name"].as_str() {
        let at = path(&kind, object["metadata"]["namespace"].as_str(), name);
        for (collection, queue) in &mut state.streams {
            if listed(&at, collection) {
                queue.push_back(event.clone());
            }
        }
    }
    state.events.push((kind, event));
}
fn advance(value: &mut Value) {
    let version: u64 = value["metadata"]["resourceVersion"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    value["metadata"]["resourceVersion"] = (version + 1).to_string().into();
}
/// Records a committed write and replies, unless the reply of this write is to be lost.
fn committed(
    state: &mut State,
    method: &str,
    path: &str,
    body: Value,
    current: &Value,
) -> Option<(u16, Vec<u8>)> {
    let lose = state.lose.as_ref().is_some_and(|lose| lose(path, &body));
    if let Some(log) = &state.log {
        log.lock().unwrap().push(format!("{method} {path} {body}"));
    }
    state.writes.push((method.into(), path.into(), body));
    if lose {
        state.lose = None;
        return None;
    }
    Some((200, serde_json::to_vec(current).unwrap()))
}
impl Server {
    pub async fn start() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![identity.cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                    identity.signing_key.serialize_der(),
                )),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = std::env::temp_dir().join(format!(
            "pgcf-native-test-api-{}-{}.token",
            std::process::id(),
            address.port()
        ));
        tokio::fs::write(&token, "generated-local-test-token")
            .await
            .unwrap();
        let k8s = Kubernetes::with_ca(
            reqwest::Url::parse(&format!("https://{address}/")).unwrap(),
            identity.cert.pem().as_bytes(),
            token.clone(),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let (acceptor, state) = (acceptor.clone(), shared.clone());
                handlers.spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut header = Vec::new();
                    let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        if tls.read_exact(&mut byte).await.is_err() {
                            return;
                        }
                        header.push(byte[0]);
                        assert!(header.len() < 64 * 1024);
                    }
                    let header = String::from_utf8(header).unwrap();
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer generated-local-test-token")
                    );
                    let mut first = header.lines().next().unwrap().split_whitespace();
                    let method = first.next().unwrap().to_string();
                    let target = first.next().unwrap();
                    let (path, query) = target.split_once('?').unwrap_or((target, ""));
                    let (path, query) = (path.to_string(), query.to_string());
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map(|(_, n)| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    let content_type = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-type"))
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .unwrap_or_default();
                    let mut body = vec![0; length];
                    tls.read_exact(&mut body).await.unwrap();
                    // A watch is answered with the events of the writes that come, as they come.
                    if method == "GET" && parameter(&query, "watch") == Some("true") {
                        let stream = {
                            let mut state = state.lock().unwrap();
                            state.requests.push((method.clone(), path.clone()));
                            state.queries.push(query.clone());
                            state.streams.push((path.clone(), VecDeque::new()));
                            state.streams.len() - 1
                        };
                        let lifetime = Duration::from_secs(
                            parameter(&query, "timeoutSeconds")
                                .and_then(|seconds| seconds.parse().ok())
                                .unwrap_or(60),
                        );
                        let _ = tls
                            .write_all(
                                b"HTTP/1.1 200 Test\r\ntransfer-encoding: chunked\r\ncontent-type: application/json\r\n\r\n",
                            )
                            .await;
                        let ends = Instant::now() + lifetime;
                        'serving: while Instant::now() < ends {
                            let events: Vec<Value> =
                                state.lock().unwrap().streams[stream].1.drain(..).collect();
                            for event in events {
                                let line = format!("{event}\n");
                                let chunk = format!("{:x}\r\n{line}\r\n", line.len());
                                if tls.write_all(chunk.as_bytes()).await.is_err() {
                                    break 'serving;
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(2)).await;
                        }
                        state.lock().unwrap().streams[stream].0 = String::new();
                        let _ = tls.write_all(b"0\r\n\r\n").await;
                        let _ = tls.shutdown().await;
                        return;
                    }
                    let (response, delay) = {
                        let mut state = state.lock().unwrap();
                        state.requests.push((method.clone(), path.clone()));
                        state.queries.push(query.clone());
                        if method == "PATCH" {
                            state.patch_types.push((path.clone(), content_type));
                        }
                        let response = handle(&mut state, &method, &path, &query, &body);
                        let delay = if method == "GET" {
                            None
                        } else {
                            state.sync();
                            state.write_reply_delay
                        };
                        (response, delay)
                    };
                    let Some((status, body)) = response else {
                        return;
                    };
                    if let Some(delay) = delay {
                        tokio::time::sleep(delay).await;
                    }
                    tls.write_all(
                        format!(
                            "HTTP/1.1 {status} Test\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                    tls.write_all(&body).await.unwrap();
                    let _ = tls.shutdown().await;
                });
            }
        });
        Self {
            k8s,
            state,
            task,
            token,
        }
    }
    /// Stores an object at the exact path the client derives from its kind, namespace and name.
    /// The object that was there, if it is the same one (the same UID), is changed to the next
    /// version, as every write changes it; another object starts at version 1.
    pub fn put(&self, mut value: Value) {
        let key = path(
            value["kind"].as_str().unwrap(),
            value["metadata"]["namespace"].as_str(),
            value["metadata"]["name"].as_str().unwrap(),
        );
        let mut state = self.state.lock().unwrap();
        if value["metadata"]["resourceVersion"].is_null() {
            match state.objects.get(&key) {
                Some(before) if before["metadata"]["uid"] == value["metadata"]["uid"] => {
                    value["metadata"]["resourceVersion"] =
                        before["metadata"]["resourceVersion"].clone();
                    advance(&mut value);
                }
                _ => value["metadata"]["resourceVersion"] = "1".into(),
            }
        }
        state.objects.insert(key, value);
        state.sync();
    }
    /// From now on the controller's watch cache follows every change of the objects: complete
    /// coverage at the current versions, with no lag.
    pub fn watch(&self) {
        let mut state = self.state.lock().unwrap();
        state.watch = Some(self.k8s.clone());
        state.sync();
    }
    /// A write by someone else than the controller: `edit` changes the object, which gets the
    /// next version and a watch event, and nothing the controller wrote is remembered for it.
    pub fn external_write(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
        edit: impl FnOnce(&mut Value),
    ) {
        let mut state = self.state.lock().unwrap();
        let at = path(kind, namespace, name);
        let mut object = state.objects.get(&at).cloned().unwrap();
        edit(&mut object);
        advance(&mut object);
        state.objects.insert(at, object.clone());
        queue_event(&mut state, "MODIFIED", &object);
        state.sync();
    }
    pub fn get(&self, kind: &str, namespace: Option<&str>, name: &str) -> Option<Value> {
        self.state
            .lock()
            .unwrap()
            .objects
            .get(&path(kind, namespace, name))
            .cloned()
    }
    pub fn edit(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
        edit: impl FnOnce(&mut Value),
    ) {
        let mut state = self.state.lock().unwrap();
        let object = state.objects.get_mut(&path(kind, namespace, name)).unwrap();
        edit(object);
        advance(object);
        state.sync();
    }
}
/// Every request the Cloudflare API double received, as (path, JSON body).
pub type Requests = Arc<Mutex<Vec<(String, Value)>>>;
/// A plain-HTTP Cloudflare API double that records each request and answers with `respond`;
/// status 0 holds the request open without a reply.
pub async fn api_double(
    respond: impl Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static,
) -> (ControlApi, Requests) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests: Requests = Arc::default();
    let (recorded, respond) = (requests.clone(), Arc::new(respond));
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (recorded, respond) = (recorded.clone(), respond.clone());
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                let (path, body) = loop {
                    let read = socket.read(&mut chunk).await.unwrap();
                    if read == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                    let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
                    let length: usize = head
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:").map(str::to_string))
                        .map_or(0, |n| n.trim().parse().unwrap());
                    if bytes.len() >= end + 4 + length {
                        let path = head.split_whitespace().nth(1).unwrap().to_string();
                        let body =
                            serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                                .unwrap_or(Value::Null);
                        break (path, body);
                    }
                };
                recorded.lock().unwrap().push((path.clone(), body.clone()));
                let (code, reply) = respond(&path, &body);
                if code == 0 {
                    return std::future::pending().await;
                }
                let reply = reply.to_string();
                let _ = socket
                    .write_all(format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes())
                    .await;
            });
        }
    });
    let api = ControlApi::double(reqwest::Url::parse(&format!("http://{address}/")).unwrap());
    (api, requests)
}
