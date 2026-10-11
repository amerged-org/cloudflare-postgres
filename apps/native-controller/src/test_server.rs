// SPDX-License-Identifier: Apache-2.0
//! In-process HTTPS Kubernetes API double for controller tests. It serves stored objects, lists
//! and text bodies, creates by POST, applies merge patches only under the request's UID and
//! resourceVersion preconditions, and can drop the reply of one committed write.
use crate::kubernetes::{Kubernetes, named};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

type LoseReply = Box<dyn Fn(&str, &Value) -> bool + Send>;
type DuringText = Box<dyn FnOnce(&mut BTreeMap<String, Value>) + Send>;
#[derive(Default)]
pub struct State {
    pub objects: BTreeMap<String, Value>,
    pub texts: BTreeMap<String, String>,
    /// Every accepted write as (method, path, request body).
    pub writes: Vec<(String, String, Value)>,
    /// The first committed PATCH matching (path, body) closes the connection without a reply.
    pub lose: Option<LoseReply>,
    /// Runs once while a text body is served, e.g. to replace an object during a scrape.
    pub during_text: Option<DuringText>,
    serial: u64,
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
fn collection(path: &str) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let rest = match parts.first() {
        Some(&"api") if parts.len() > 2 => &parts[2..],
        Some(&"apis") if parts.len() > 3 => &parts[3..],
        _ => return false,
    };
    rest.len() == 1 || (rest.len() == 3 && rest[0] == "namespaces")
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
fn handle(state: &mut State, method: &str, path: &str, body: &[u8]) -> Option<(u16, Vec<u8>)> {
    let reply = |status: u16, value: &Value| Some((status, serde_json::to_vec(value).unwrap()));
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
                    .map(|(_, value)| value.clone())
                    .collect();
                return reply(
                    200,
                    &json!({"kind":"List","metadata":{"resourceVersion":"1"},"items":items}),
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
            state.objects.insert(key.clone(), value.clone());
            state.writes.push((method.into(), key, value.clone()));
            reply(201, &value)
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
            let version: u64 = current["metadata"]["resourceVersion"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            current["metadata"]["resourceVersion"] = (version + 1).to_string().into();
            state.objects.insert(path.into(), current.clone());
            state
                .writes
                .push((method.into(), path.into(), patch.clone()));
            if state.lose.as_ref().is_some_and(|lose| lose(path, &patch)) {
                state.lose = None;
                return None;
            }
            reply(200, &current)
        }
        _ => reply(405, &json!({})),
    }
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
                    let path = first.next().unwrap().split('?').next().unwrap().to_string();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map(|(_, n)| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    tls.read_exact(&mut body).await.unwrap();
                    let response = handle(&mut state.lock().unwrap(), &method, &path, &body);
                    let Some((status, body)) = response else {
                        return;
                    };
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
    pub fn put(&self, mut value: Value) {
        if value["metadata"]["resourceVersion"].is_null() {
            value["metadata"]["resourceVersion"] = "1".into();
        }
        let key = path(
            value["kind"].as_str().unwrap(),
            value["metadata"]["namespace"].as_str(),
            value["metadata"]["name"].as_str().unwrap(),
        );
        self.state.lock().unwrap().objects.insert(key, value);
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
        edit(
            self.state
                .lock()
                .unwrap()
                .objects
                .get_mut(&path(kind, namespace, name))
                .unwrap(),
        );
    }
}
