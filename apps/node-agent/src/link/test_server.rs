// SPDX-License-Identifier: Apache-2.0
//! A Cloudflare double that speaks the node contract over TLS. It verifies every signed request
//! as the Worker does (`verifyNodeRequest`), enrolls one node, serves the node's desired pages in
//! the contract's paging, records what the node posts, and runs the node's WebSocket link.
use crate::node_link::{constant, contract_valid};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use ring::signature::{ED25519, UnparsedPublicKey};
use rustls::RootCertStore;
use rustls_pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::broadcast,
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
};

pub const NODE_ID: &str = "nod_nnnnnnnnnnnnnnnnnnnn";
pub const NODE_UID: &str = "01234567-89ab-4def-8123-0123456789ab";
pub const TOKEN: &str = "pgcf_et_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/native/node-vectors.generated.json"
    ))
    .unwrap()
});
/// The valid example `name` of the contract schema `schema`.
pub fn vector(schema: &str, name: &str) -> Value {
    VECTORS["schemas"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["schema"] == schema && v["name"] == name && v["valid"] == true)
        .unwrap_or_else(|| panic!("no vector {schema}/{name}"))["value"]
        .clone()
}
/// The contract's examples of an installed package set: the `dpkg-query` output, the set it states
/// and the digest the contract computes of it.
pub fn package_vectors() -> Vec<Value> {
    VECTORS["packages"].as_array().unwrap().clone()
}
/// The contract's examples of a release as the page names it, with the text its signature covers.
pub fn release_vectors() -> Vec<Value> {
    VECTORS["releases"].as_array().unwrap().clone()
}
/// A desired database of the contract's example page, under another identifier.
pub fn database(id: &str) -> Value {
    let page = vector("NodeDesiredPage", "full-page");
    let example = page["databases"][0].clone();
    serde_json::from_str(
        &example
            .to_string()
            .replace(example["id"].as_str().unwrap(), id),
    )
    .unwrap()
}
/// Identifiers in order: `a0000000000000000000`, `a0000000000000000001`, ...
pub fn database_id(index: usize) -> String {
    format!("a{index:019}")
}

/// The property a later release adds (`with_unknown_properties`).
pub const UNKNOWN_PROPERTY: &str = "a_property_of_a_later_release";
/// `value` with a property this build does not know on every object of it, as a later release of
/// the API adds one. The `keys` of a route keyring are a map of key identifiers and take none.
pub fn with_unknown_properties(value: &Value) -> Value {
    fn add(value: &mut Value, map: bool) {
        match value {
            Value::Object(object) => {
                for (key, child) in object.iter_mut() {
                    add(child, key == "keys");
                }
                if !map {
                    object.insert(UNKNOWN_PROPERTY.into(), 1.into());
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| add(item, false)),
            _ => {}
        }
    }
    let mut value = value.clone();
    add(&mut value, false);
    value
}

/// What the double does with the next POSTs (the enrollment included), after it recorded them.
#[derive(Clone, Copy, Debug)]
pub enum Failure {
    /// Answers as usual: the failures queued behind it fall on later POSTs.
    Pass,
    /// Answers with this status instead of success.
    Status(u16),
    /// Closes the connection without an answer: the node cannot tell whether it was applied.
    Drop,
}

/// One request the double received.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub body: Value,
    /// Whether its signature verified (`None` for the enrollment, which is unsigned).
    pub signed: Option<Result<(), &'static str>>,
    pub status: u16,
}
impl Seen {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap()
    }
}

#[derive(Clone, Debug)]
enum Command {
    Send(String),
    Drop,
    Stall,
}

pub struct Inner {
    pub public_key: Option<Vec<u8>>,
    pub image_version: Option<String>,
    pub requests: Vec<Seen>,
    pub failures: VecDeque<Failure>,
    pub fenced: bool,
    pub databases: Vec<Value>,
    pub orders: Vec<Value>,
    /// The probes of an administrator that every page lists (`NodeDiagnosticRequest`). They stay on
    /// the page after they are answered, as a page pulled while the answer was on its way lists them.
    pub diagnostics: Vec<Value>,
    /// The next this many results of probes are answered 503, whatever else is posted meanwhile.
    pub probe_failures: usize,
    /// The same for the next this many boot reports.
    pub boot_failures: usize,
    /// The next this many observation reports that name databases are answered 503: the ones that
    /// carry events alone are not counted, as the node posts those on its own account.
    pub observation_failures: usize,
    /// The verdict the double gives a database of an observation report, where it is not `accept`
    /// (`ObservationVerdict`).
    pub verdicts: std::collections::HashMap<String, &'static str>,
    /// The node uid the desired pages name; the enrolled node's own unless a test changes it.
    pub page_uid: String,
    /// The pages never advance their cursor.
    pub stuck: bool,
    /// The link accepts the hello and never answers it.
    pub silent_welcome: bool,
    pub upgrades: usize,
    pub hellos: Vec<Value>,
    pub samples: Vec<Value>,
    /// The archive path a credential identifier is for, where it is not the example's.
    pub credential_paths: std::collections::HashMap<String, String>,
    /// Credential identifiers whose archive scope grants read-only access.
    pub read_only_credentials: std::collections::HashSet<String>,
    /// How long the double takes to answer a read of an archive credential, as the Worker takes
    /// (a lookup in D1 and a round trip): zero unless a test gives it one.
    pub credential_delay: Duration,
    /// The same for a read of the node's credentials (the Tunnel and the route keyring), which the
    /// Worker answers after several calls to Cloudflare's API.
    pub node_credentials_delay: Duration,
    /// The same for a read of the desired page (the Worker reads D1 and builds the page).
    pub page_delay: Duration,
    /// Files served to anyone at `/files/...`, as a release's binaries are by their URLs.
    pub files: std::collections::HashMap<String, Vec<u8>>,
    /// The release the pages name, where it is not the example's.
    pub release: Option<Value>,
    /// The credentials a read returns, where they are not the example's; the pages name their
    /// revision.
    pub credentials: Option<Value>,
    /// The policy the pages carry, where it is not the example's.
    pub policy: Option<Value>,
    /// The API of a later release: every object it sends (pages, credentials, the enrollment, the
    /// welcome and the fence) carries a property this build does not know.
    pub unknown_properties: bool,
}
pub struct Cloud {
    pub origin: String,
    authority: rcgen::CertifiedIssuer<'static, rcgen::KeyPair>,
    inner: Arc<Mutex<Inner>>,
    commands: broadcast::Sender<Command>,
    task: JoinHandle<()>,
}
impl Drop for Cloud {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Cloud {
    /// A double on the IPv4 loopback.
    pub async fn start() -> Self {
        Self::start_on("127.0.0.1:0").await
    }
    /// A double that listens on `address` alone, the IPv4 or the IPv6 loopback.
    pub async fn start_on(address: &str) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let authority =
            rcgen::CertifiedIssuer::self_signed(params, rcgen::KeyPair::generate().unwrap())
                .unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let mut leaf = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        leaf.subject_alt_names = vec![
            rcgen::SanType::IpAddress("127.0.0.1".parse().unwrap()),
            rcgen::SanType::IpAddress("::1".parse().unwrap()),
            rcgen::SanType::DnsName("localhost".try_into().unwrap()),
        ];
        let leaf = leaf.signed_by(&key, &authority).unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind(address)
            .await
            .unwrap_or_else(|error| panic!("the double cannot listen on {address}: {error}"));
        let address = listener.local_addr().unwrap();
        let inner = Arc::new(Mutex::new(Inner {
            public_key: None,
            image_version: None,
            requests: vec![],
            failures: VecDeque::new(),
            fenced: false,
            databases: vec![],
            orders: vec![],
            diagnostics: vec![],
            probe_failures: 0,
            boot_failures: 0,
            observation_failures: 0,
            verdicts: std::collections::HashMap::new(),
            page_uid: NODE_UID.into(),
            stuck: false,
            silent_welcome: false,
            upgrades: 0,
            hellos: vec![],
            samples: vec![],
            credential_paths: Default::default(),
            read_only_credentials: Default::default(),
            credential_delay: Duration::ZERO,
            node_credentials_delay: Duration::ZERO,
            page_delay: Duration::ZERO,
            files: Default::default(),
            release: None,
            credentials: None,
            policy: None,
            unknown_properties: false,
        }));
        let (commands, _) = broadcast::channel(16);
        let task = tokio::spawn({
            let (inner, commands) = (inner.clone(), commands.clone());
            async move {
                loop {
                    let Ok((tcp, _)) = listener.accept().await else {
                        return;
                    };
                    let (acceptor, inner, commands) =
                        (acceptor.clone(), inner.clone(), commands.clone());
                    tokio::spawn(async move {
                        let _ = serve(acceptor, tcp, inner, commands).await;
                    });
                }
            }
        });
        Self {
            origin: format!("https://{address}"),
            authority,
            inner,
            commands,
            task,
        }
    }
    pub fn roots(&self) -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots.add(self.authority.der().clone()).unwrap();
        roots
    }
    pub fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        f(&mut self.inner.lock().unwrap())
    }
    /// The installer's seed under `base`, naming this double as the API.
    pub fn seed(&self, base: &Path) {
        self.seed_for(base, &self.origin);
    }
    /// The seed for the API at `api_url`, which the contract allows to be an origin with a host name
    /// only: an address of the double's is reached as `localhost`.
    pub fn seed_for(&self, base: &Path, api_url: &str) {
        let directory = base.join("enrollment");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("seed.json"),
            json!({"node_id":NODE_ID,"region":"eu-dev","api_url":api_url,"enrollment_token":TOKEN})
                .to_string(),
        )
        .unwrap();
    }
    /// The URL of `path` on this double.
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }
    /// Serves `bytes` to anyone at `path` (`/files/...`); the URL names this double.
    pub fn serve_file(&self, path: &str, bytes: impl Into<Vec<u8>>) -> String {
        self.with(|inner| inner.files.insert(path.to_string(), bytes.into()));
        self.url(path)
    }
    pub fn fail_next(&self, failures: impl IntoIterator<Item = Failure>) {
        self.with(|inner| inner.failures.extend(failures));
    }
    pub fn requests(&self) -> Vec<Seen> {
        self.with(|inner| inner.requests.clone())
    }
    /// The bodies of the requests to `path` that the double answered with success.
    pub fn acknowledged(&self, path: &str) -> Vec<Value> {
        self.requests()
            .into_iter()
            .filter(|seen| seen.path() == path && (200..300).contains(&seen.status))
            .map(|seen| seen.body)
            .collect()
    }
    /// Every request to `path`, answered or not.
    pub fn posted(&self, path: &str) -> Vec<Value> {
        self.requests()
            .into_iter()
            .filter(|seen| seen.path() == path)
            .map(|seen| seen.body)
            .collect()
    }
    /// Sends `message` over the link of the node.
    pub fn push(&self, message: Value) {
        let _ = self.commands.send(Command::Send(message.to_string()));
    }
    /// Closes the link without a closing handshake.
    pub fn drop_links(&self) {
        let _ = self.commands.send(Command::Drop);
    }
    /// Stops reading the link, so that it answers neither messages nor pings.
    pub fn stall_links(&self) {
        let _ = self.commands.send(Command::Stall);
    }
}

/// Polls `condition` until it holds.
pub async fn eventually(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "the condition never held");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}
async fn read_request<S: AsyncReadExt + Unpin>(stream: &mut S) -> Option<Request> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(key, _)| key == "content-length")
        .map_or(0, |(_, value)| value.parse().unwrap());
    let mut body = bytes[end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Request {
        method,
        target,
        headers,
        body,
    })
}

/// The Worker's check of a signed node request.
fn verify(
    public_key: &[u8],
    header: Option<&str>,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<(), &'static str> {
    let token = header
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or("missing")?;
    let parts: Vec<&str> = token.split('.').collect();
    let [prefix, payload, signature] = parts[..] else {
        return Err("malformed");
    };
    if prefix != constant("NODE_REQUEST_TOKEN_PREFIX") || token.len() > 2048 {
        return Err("malformed");
    }
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| "malformed")?;
    let signed = format!(
        "{}{payload}",
        constant("NODE_REQUEST_SIGNATURE_DOMAIN").as_str().unwrap()
    );
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(signed.as_bytes(), &signature)
        .map_err(|_| "signature")?;
    let claims: Value = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("malformed")?;
    if !contract_valid("NodeRequestClaims", &claims) {
        return Err("claims");
    }
    let hash: String = Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if claims["node"] != NODE_ID || claims["uid"] != NODE_UID {
        return Err("node_mismatch");
    }
    if claims["method"] != method || claims["path"] != target || claims["body"] != hash {
        return Err("request_mismatch");
    }
    let (iat, exp) = (
        claims["iat"].as_u64().unwrap(),
        claims["exp"].as_u64().unwrap(),
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    if exp <= iat || exp - iat > 60 || iat > now + 30 || now > exp + 30 {
        return Err("lifetime");
    }
    Ok(())
}

fn error(code: &str) -> Value {
    json!({"error":{"code":code,"message":"refused","request_id":"test"}})
}
struct Answer {
    status: u16,
    body: Value,
    /// The bytes of a file, instead of the JSON body.
    raw: Option<Vec<u8>>,
}
fn answer(status: u16, body: Value) -> Answer {
    Answer {
        status,
        body,
        raw: None,
    }
}

fn identity() -> Value {
    json!({"id":NODE_ID,"uid":NODE_UID,"hostname":"eu1","region_id":"eu-dev"})
}

/// One page of the node's databases: after the cursor, at most `limit`, or those of `ids`.
fn desired(inner: &Inner, query: &[(String, String)]) -> Value {
    let get = |name: &str| {
        query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let mut node = identity();
    node["uid"] = inner.page_uid.clone().into();
    let example = vector("NodeDesiredPage", "full-page");
    let mut rows: Vec<Value> = inner.databases.clone();
    rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut next = Value::Null;
    if let Some(ids) = get("ids") {
        let ids: Vec<&str> = ids.split(',').collect();
        rows.retain(|db| ids.contains(&db["id"].as_str().unwrap()));
    } else {
        if let Some(after) = get("after") {
            rows.retain(|db| db["id"].as_str().unwrap() > after);
        }
        let limit: usize = get("limit").map_or(200, |v| v.parse().unwrap());
        if rows.len() > limit {
            rows.truncate(limit);
            next = rows.last().unwrap()["id"].clone();
        }
    }
    if inner.stuck {
        if get("after").is_some() {
            rows.clear();
        }
        next = database_id(0).into();
    }
    // A fenced node's page holds no release.
    let release = if inner.fenced {
        Value::Null
    } else {
        inner.release.clone().unwrap_or(example["release"].clone())
    };
    let credentials_revision = inner
        .credentials
        .as_ref()
        .map_or(json!(3), |credentials| credentials["revision"].clone());
    let policy = inner.policy.clone().unwrap_or(example["policy"].clone());
    let mut page = json!({"node":node,"release":release,"policy":policy,"credentials_revision":credentials_revision,"orders":inner.orders,"databases":rows,"next":next});
    if !inner.diagnostics.is_empty() && !inner.fenced {
        page["diagnostics"] = inner.diagnostics.clone().into();
    }
    page
}

fn route(inner: &mut Inner, method: &str, target: &str, body: &Value) -> Answer {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query: Vec<(String, String)> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    let paths = constant("NODE_API_PATHS");
    let is = |name: &str| path == paths[name].as_str().unwrap();
    if inner.fenced && !(is("desired") || is("observations")) {
        return answer(403, json!({"error":"node_fenced"}));
    }
    let post = |schema: &str| {
        if method != "POST" || !contract_valid(schema, body) {
            return answer(400, error("invalid_request"));
        }
        answer(200, json!({}))
    };
    if is("desired") && method == "GET" {
        answer(200, desired(inner, &query))
    } else if is("credentials") && method == "GET" {
        answer(
            200,
            inner
                .credentials
                .clone()
                .unwrap_or_else(|| vector("NodeCredentials", "credentials")),
        )
    } else if let Some(id) = path.strip_prefix(paths["archiveCredentials"].as_str().unwrap()) {
        let mut credential = vector("ArchiveCredential", "read-write");
        credential["id"] = id.into();
        if inner.read_only_credentials.contains(id) {
            credential["access"] = "read_only".into();
        }
        if let Some(path) = inner.credential_paths.get(id) {
            credential["path"] = path.as_str().into();
        }
        answer(200, credential)
    } else if is("observations") {
        if method != "POST" || !contract_valid("NodeObservationReport", body) {
            return answer(400, error("invalid_request"));
        }
        // As the API answers (`nodeObservations`): a verdict on each database of the report, in its
        // order, and how many results of orders it took; a fenced node's databases are not read.
        let databases: Vec<Value> = body["databases"]
            .as_array()
            .filter(|_| !inner.fenced)
            .into_iter()
            .flatten()
            .map(|db| {
                let id = db["id"].as_str().unwrap();
                json!({"id": id, "verdict": inner.verdicts.get(id).copied().unwrap_or("accept")})
            })
            .collect();
        answer(
            200,
            json!({"databases": databases, "orders": body["orders"].as_array().map_or(0, Vec::len)}),
        )
    } else if is("volumes") {
        post("NodeVolumeReport")
    } else if is("events") {
        post("NodeEventReport")
    } else if is("usage") {
        post("NodeUsageReport")
    } else if is("diagnostics") {
        post(if body["kind"] == "probe" {
            "NodeProbeResult"
        } else {
            "NodeBootReport"
        })
    } else {
        answer(404, error("not_found"))
    }
}

async fn respond<S: AsyncWriteExt + Unpin>(stream: &mut S, answer: &Answer) {
    let (body, kind) = match &answer.raw {
        Some(bytes) => (bytes.clone(), "application/octet-stream"),
        None => (answer.body.to_string().into_bytes(), "application/json"),
    };
    let mut message = format!(
        "HTTP/1.1 {} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        answer.status,
        body.len()
    )
    .into_bytes();
    message.extend_from_slice(&body);
    let _ = stream.write_all(&message).await;
    let _ = stream.shutdown().await;
}

async fn serve(
    acceptor: TlsAcceptor,
    tcp: TcpStream,
    inner: Arc<Mutex<Inner>>,
    commands: broadcast::Sender<Command>,
) -> std::io::Result<()> {
    let mut stream = acceptor.accept(tcp).await?;
    let Some(request) = read_request(&mut stream).await else {
        return Ok(());
    };
    let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
    let enrolling = request.target == constant("NODE_API_PATHS")["enroll"].as_str().unwrap();
    let public = request.method == "GET" && request.target.starts_with("/files/");
    let upgrade = request
        .header("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let (answer, failure, delay) = {
        let mut inner = inner.lock().unwrap();
        let signed = if enrolling || public {
            None
        } else {
            Some(match &inner.public_key {
                Some(key) => verify(
                    key,
                    request.header("authorization"),
                    &request.method,
                    &request.target,
                    &request.body,
                ),
                None => Err("not_enrolled"),
            })
        };
        let diagnostic = request.method == "POST"
            && request.target == constant("NODE_API_PATHS")["diagnostics"].as_str().unwrap();
        let probe = diagnostic && body["kind"] == "probe";
        let observed = request.method == "POST"
            && request.target == constant("NODE_API_PATHS")["observations"].as_str().unwrap()
            && body["databases"].as_array().is_some_and(|d| !d.is_empty());
        let failure = if probe && inner.probe_failures > 0 {
            inner.probe_failures -= 1;
            Some(Failure::Status(503))
        } else if diagnostic && !probe && inner.boot_failures > 0 {
            inner.boot_failures -= 1;
            Some(Failure::Status(503))
        } else if observed && inner.observation_failures > 0 {
            inner.observation_failures -= 1;
            Some(Failure::Status(503))
        } else if request.method == "POST" {
            inner.failures.pop_front()
        } else {
            None
        };
        let answer = if enrolling {
            enroll(&mut inner, &body)
        } else if public {
            match inner.files.get(&request.target) {
                Some(bytes) => Answer {
                    status: 200,
                    body: Value::Null,
                    raw: Some(bytes.clone()),
                },
                None => answer(404, error("not_found")),
            }
        } else if matches!(signed, Some(Err(_))) {
            answer(401, error("unauthorized"))
        } else if upgrade && inner.fenced {
            answer(403, json!({"error":"node_fenced"}))
        } else if upgrade {
            inner.upgrades += 1;
            answer(101, Value::Null)
        } else {
            route(&mut inner, &request.method, &request.target, &body)
        };
        let answer = if inner.unknown_properties {
            Answer {
                body: with_unknown_properties(&answer.body),
                ..answer
            }
        } else {
            answer
        };
        let status = match failure {
            Some(Failure::Status(status)) => status,
            _ => answer.status,
        };
        inner.requests.push(Seen {
            method: request.method.clone(),
            target: request.target.clone(),
            body: body.clone(),
            signed,
            status,
        });
        let paths = constant("NODE_API_PATHS");
        let delay = if request
            .target
            .starts_with(paths["archiveCredentials"].as_str().unwrap())
        {
            inner.credential_delay
        } else if request.target == paths["credentials"].as_str().unwrap() {
            inner.node_credentials_delay
        } else if request.method == "GET"
            && request
                .target
                .starts_with(paths["desired"].as_str().unwrap())
        {
            inner.page_delay
        } else {
            Duration::ZERO
        };
        (answer, failure, delay)
    };
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    match failure {
        Some(Failure::Drop) => return Ok(()),
        Some(Failure::Status(status)) => {
            respond(&mut stream, &self::answer(status, error("unavailable"))).await;
            return Ok(());
        }
        Some(Failure::Pass) | None => {}
    }
    if answer.status == 101 {
        let key = request.header("sec-websocket-key").unwrap_or_default();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
                    derive_accept_key(key.as_bytes())
                )
                .as_bytes(),
            )
            .await?;
        let socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
        session(socket, inner, commands.subscribe()).await;
        return Ok(());
    }
    respond(&mut stream, &answer).await;
    Ok(())
}

/// POST /node/v1/enroll: the first key is bound to the node; the same token and key repeat the
/// answer, anything else is refused.
fn enroll(inner: &mut Inner, body: &Value) -> Answer {
    if !contract_valid("NodeEnrollmentRequest", body) || body["enrollment_token"] != TOKEN {
        return answer(403, error("enrollment_refused"));
    }
    let key = URL_SAFE_NO_PAD
        .decode(body["public_key"].as_str().unwrap())
        .unwrap();
    match &inner.public_key {
        Some(bound) if *bound != key => return answer(403, error("enrollment_refused")),
        _ => inner.public_key = Some(key),
    }
    inner.image_version = body["image_version"].as_str().map(str::to_string);
    answer(200, identity())
}

async fn session<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    mut socket: WebSocketStream<S>,
    inner: Arc<Mutex<Inner>>,
    mut commands: broadcast::Receiver<Command>,
) {
    let Some(Ok(Message::Text(hello))) = socket.next().await else {
        return;
    };
    let hello: Value = serde_json::from_str(hello.as_str()).unwrap_or(Value::Null);
    if !contract_valid("AgentLinkMessage", &hello) || hello["type"] != "hello" {
        return;
    }
    let (silent, welcome) = {
        let mut inner = inner.lock().unwrap();
        inner.hellos.push(hello);
        let welcome = json!({"type":"welcome","protocol":1});
        let welcome = if inner.unknown_properties {
            with_unknown_properties(&welcome)
        } else {
            welcome
        };
        (inner.silent_welcome, welcome)
    };
    if silent {
        return std::future::pending().await;
    }
    if socket
        .send(Message::text(welcome.to_string()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let message: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                    if !contract_valid("AgentLinkMessage", &message) || message["type"] != "sample" {
                        return;
                    }
                    inner.lock().unwrap().samples.push(message["sample"].clone());
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => return,
            },
            command = commands.recv() => match command {
                Ok(Command::Send(text)) => {
                    if socket.send(Message::text(text)).await.is_err() {
                        return;
                    }
                }
                Ok(Command::Drop) | Err(_) => return,
                Ok(Command::Stall) => std::future::pending::<()>().await,
            },
        }
    }
}

/// A new empty directory under the system's temporary directory, removed with everything in it
/// when the test is done with it, however the test ended.
pub struct TempDir(std::path::PathBuf);
impl std::ops::Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}
impl AsRef<std::ffi::OsStr> for TempDir {
    fn as_ref(&self) -> &std::ffi::OsStr {
        self.0.as_os_str()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn tempdir() -> TempDir {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "pgcf-link-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    TempDir(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temporary_directory_is_removed_with_its_contents_when_dropped() {
        let directory = tempdir();
        let path = directory.to_path_buf();
        std::fs::create_dir_all(path.join("credentials")).unwrap();
        std::fs::write(path.join("credentials/node-key.pk8"), b"key").unwrap();
        drop(directory);
        assert!(!path.exists());
    }
}
