// SPDX-License-Identifier: Apache-2.0
//! Actual loopback sockets. This is byte/protocol conformance, not fleet acceptance.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use pgcf_native_bootstrap_relay::{
    authority::{Configuration, VerificationKeys, wire},
    transport::{Relay, Running},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderName},
};
type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;
#[derive(Serialize)]
struct Target {
    address: String,
    port: u16,
}
#[derive(Serialize)]
struct Claims {
    v: u8,
    region: String,
    issuer_region: String,
    relay_epoch: String,
    purpose: String,
    operation: String,
    node: String,
    revision: u64,
    capability: String,
    target: Target,
    nonce: String,
    kid: String,
    iat: u64,
    exp: u64,
}
struct Fixture {
    server: Running,
    pair: Ed25519KeyPair,
    target: String,
    dials: Arc<AtomicUsize>,
    backend: Option<JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.backend.take() {
            task.abort();
        }
    }
}
impl Fixture {
    async fn new(index: u8, session_ms: u64, connections: usize) -> Self {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let keys = VerificationKeys::parse(
            &json!({"test":URL_SAFE_NO_PAD.encode(pair.public_key().as_ref())}).to_string(),
        )
        .unwrap();
        let mut configuration = Configuration::new(
            "eu-test".into(),
            "eu-test".into(),
            vec!["eu-test".into(), "us-test".into()],
            "127.0.0.1".parse().unwrap(),
            0,
            keys,
        )
        .unwrap();
        configuration.session_ms = session_ms;
        configuration.connections = connections;
        let server = Relay::bind(configuration).await.unwrap();
        let target = Ipv4Addr::new(127, 0, 0, index);
        let listener = TcpListener::bind((target, 50000)).await.unwrap();
        let dials = Arc::new(AtomicUsize::new(0));
        let count = dials.clone();
        let backend = tokio::spawn(async move {
            let mut jobs = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                jobs.spawn(async move {
                    let (mut read, mut write) = socket.into_split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        Self {
            server,
            pair,
            target: target.to_string(),
            dials,
            backend: Some(backend),
        }
    }
    fn claims(&self, nonce: u64) -> Claims {
        let now = pgcf_native_gateway::control::now() / 1000;
        Claims {
            v: 1,
            region: "eu-test".into(),
            issuer_region: "eu-test".into(),
            relay_epoch: self.server.relay.identity().relay_epoch.clone(),
            purpose: "bootstrap".into(),
            operation: format!("op_{}", "a".repeat(20)),
            node: format!("nod_{}", "b".repeat(20)),
            revision: 1,
            capability: "talos_api".into(),
            target: Target {
                address: self.target.clone(),
                port: 50000,
            },
            nonce: format!("{nonce:032}"),
            kid: "test".into(),
            iat: now,
            exp: now + 30,
        }
    }
    fn sign(&self, claims: &Claims) -> String {
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = self
            .pair
            .sign(format!("{}{body}", wire("purpose")).as_bytes());
        format!(
            "{}.{body}.{}",
            wire("prefix"),
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }
    async fn connect_token(
        &self,
        token: &str,
    ) -> Result<Client, tokio_tungstenite::tungstenite::Error> {
        let mut request = format!("ws://{}{}", self.server.address, wire("path"))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            HeaderName::from_bytes(wire("header").as_bytes()).unwrap(),
            token.parse().unwrap(),
        );
        connect_async(request).await.map(|v| v.0)
    }
    async fn connect(&self, nonce: u64) -> Client {
        timeout(
            Duration::from_secs(10),
            self.connect_token(&self.sign(&self.claims(nonce))),
        )
        .await
        .unwrap()
        .unwrap()
    }
    async fn wait_empty(&self) {
        timeout(Duration::from_secs(2), async {
            loop {
                if self.server.relay.snapshot()["connections"] == 0
                    && self.server.relay.snapshot()["memoryUsed"] == 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
async fn read_bytes(client: &mut Client, length: usize) -> Vec<u8> {
    timeout(Duration::from_secs(10), async {
        let mut bytes = Vec::new();
        while bytes.len() < length {
            match client.next().await.unwrap().unwrap() {
                Message::Binary(value) => bytes.extend_from_slice(&value),
                Message::Ping(value) => client.send(Message::Pong(value)).await.unwrap(),
                value => panic!("unexpected frame {value:?}"),
            }
        }
        bytes
    })
    .await
    .unwrap()
}
async fn response(address: SocketAddr, path: &str, token: Option<&str>) -> (u16, Value) {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let header = token
        .map(|v| format!("{}: {v}\r\n", wire("header")))
        .unwrap_or_default();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: local\r\n{header}Connection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let end = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    let head = std::str::from_utf8(&bytes[..end]).unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (
        status,
        if bytes.len() == end {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[end..]).unwrap()
        },
    )
}
#[tokio::test]
async fn authenticated_bytes_cross_tcp_once_and_replay_cannot_redial() {
    let f = Fixture::new(11, 10000, 2).await;
    let token = f.sign(&f.claims(1));
    let mut client = f.connect_token(&token).await.unwrap();
    let bytes = (0..65536).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    client
        .send(Message::Binary(bytes.clone().into()))
        .await
        .unwrap();
    assert_eq!(read_bytes(&mut client, bytes.len()).await, bytes);
    assert_eq!(f.dials.load(Ordering::SeqCst), 1);
    let _ = client.close(None).await;
    drop(client);
    f.wait_empty().await;
    let error = f.connect_token(&token).await.unwrap_err();
    assert!(
        matches!(error,tokio_tungstenite::tungstenite::Error::Http(response)if response.status()==401)
    );
    assert_eq!(f.dials.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn wrong_signature_epoch_port_and_expiry_contact_no_upstream() {
    let f = Fixture::new(12, 10000, 2).await;
    let mut claims = f.claims(1);
    claims.relay_epoch = "01234567-89ab-4def-8123-0123456789ab".into();
    assert!(f.connect_token(&f.sign(&claims)).await.is_err());
    let mut claims = f.claims(2);
    claims.target.port = 22;
    assert!(f.connect_token(&f.sign(&claims)).await.is_err());
    let mut claims = f.claims(3);
    claims.iat -= 60;
    claims.exp -= 60;
    assert!(f.connect_token(&f.sign(&claims)).await.is_err());
    let mut token = f.sign(&f.claims(4));
    token.replace_range(token.len() - 1.., "!");
    assert!(f.connect_token(&token).await.is_err());
    assert_eq!(f.dials.load(Ordering::SeqCst), 0);
    f.wait_empty().await;
}
#[tokio::test]
async fn capacity_deadline_and_cross_region_scope_are_enforced_without_redial() {
    let f = Fixture::new(13, 250, 1).await;
    let mut claims = f.claims(1);
    claims.region = "us-test".into();
    let mut client = f.connect_token(&f.sign(&claims)).await.unwrap();
    client
        .send(Message::Binary(b"ready".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(read_bytes(&mut client, 5).await, b"ready");
    let error = f.connect_token(&f.sign(&f.claims(2))).await.unwrap_err();
    assert!(
        matches!(error,tokio_tungstenite::tungstenite::Error::Http(response)if response.status()==503)
    );
    timeout(Duration::from_secs(2), async {
        while let Some(Ok(value)) = client.next().await {
            if matches!(value, Message::Close(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    drop(client);
    f.wait_empty().await;
    assert_eq!(f.dials.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn identity_and_socket_source_probe_match_the_authenticated_target() {
    let f = Fixture::new(14, 10000, 2).await;
    let (status, identity) = response(f.server.address, wire("identityPath"), None).await;
    assert_eq!(status, 200);
    assert_eq!(identity["region"], "eu-test");
    assert_eq!(identity["issuer_region"], "eu-test");
    let token = f.sign(&f.claims(1));
    let (status, probe) = response(f.server.address, wire("probePath"), Some(&token)).await;
    assert_eq!(status, 200);
    assert_eq!(probe["outcome"], "connected");
    assert_eq!(probe["address"], f.target);
    assert!(
        probe["source"]
            .as_str()
            .unwrap()
            .parse::<std::net::IpAddr>()
            .unwrap()
            .is_loopback()
    );
    let (status, _) = response(f.server.address, wire("probePath"), Some(&token)).await;
    assert_eq!(status, 401);
    assert_eq!(f.dials.load(Ordering::SeqCst), 1);
    f.wait_empty().await;
}
#[tokio::test]
async fn oversized_header_only_frame_closes_only_its_offender_and_releases_memory() {
    let f = Fixture::new(15, 10000, 2).await;
    let mut healthy = f.connect(1).await;
    let token = f.sign(&f.claims(2));
    let mut raw = TcpStream::connect(f.server.address).await.unwrap();
    raw.write_all(format!("GET {} HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{}: {token}\r\n\r\n",wire("path"),wire("header")).as_bytes()).await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0];
        raw.read_exact(&mut b).await.unwrap();
        head.push(b[0]);
        assert!(head.len() < 8192);
    }
    assert!(
        std::str::from_utf8(&head)
            .unwrap()
            .starts_with("HTTP/1.1 101")
    );
    raw.write_all(&[0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4])
        .await
        .unwrap();
    let mut next = [0; 64];
    let _ = timeout(Duration::from_secs(2), raw.read(&mut next))
        .await
        .unwrap();
    drop(raw);
    healthy
        .send(Message::Binary(b"still-live".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(read_bytes(&mut healthy, 10).await, b"still-live");
    assert!(f.server.relay.snapshot()["memoryUsed"].as_u64().unwrap() <= 2 * 512 * 1024);
    let _ = healthy.close(None).await;
    drop(healthy);
    f.wait_empty().await;
}
#[test]
fn cli_rejects_unknown_and_private_inputs_without_echoing_canaries() {
    let binary = env!("CARGO_BIN_EXE_pgcf-native-bootstrap-relay");
    let value = std::process::Command::new(binary)
        .arg("--private-key=BOOTSTRAP_PRIVATE_CANARY")
        .output()
        .unwrap();
    assert!(!value.status.success());
    assert!(!String::from_utf8_lossy(&value.stderr).contains("CANARY"));
    let value = std::process::Command::new(binary)
        .env_clear()
        .env(
            "PGCF_BOOTSTRAP_RELAY_PRIVATE_KEY",
            "BOOTSTRAP_PRIVATE_CANARY",
        )
        .output()
        .unwrap();
    assert!(!value.status.success());
    assert!(!String::from_utf8_lossy(&value.stderr).contains("CANARY"));
}

struct WsBytes<S> {
    socket: WebSocketStream<S>,
    pending: Vec<u8>,
    position: usize,
}
impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> tokio::io::AsyncRead for WsBytes<S> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        output: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use futures_util::Stream;
        let this = self.get_mut();
        loop {
            if this.position < this.pending.len() {
                let take = output.remaining().min(this.pending.len() - this.position);
                output.put_slice(&this.pending[this.position..this.position + take]);
                this.position += take;
                return std::task::Poll::Ready(Ok(()));
            }
            match std::pin::Pin::new(&mut this.socket).poll_next(cx) {
                std::task::Poll::Pending => return std::task::Poll::Pending,
                std::task::Poll::Ready(Some(Ok(Message::Binary(bytes)))) => {
                    this.pending = bytes.to_vec();
                    this.position = 0;
                }
                std::task::Poll::Ready(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                std::task::Poll::Ready(Some(Err(error))) => {
                    return std::task::Poll::Ready(Err(std::io::Error::other(error)));
                }
                std::task::Poll::Ready(_) => return std::task::Poll::Ready(Ok(())),
            }
        }
    }
}
impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for WsBytes<S> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        use futures_util::Sink;
        let this = self.get_mut();
        match std::pin::Pin::new(&mut this.socket).poll_ready(cx) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(Err(error)) => {
                std::task::Poll::Ready(Err(std::io::Error::other(error)))
            }
            std::task::Poll::Ready(Ok(())) => {
                match std::pin::Pin::new(&mut this.socket)
                    .start_send(Message::Binary(bytes.to_vec().into()))
                {
                    Ok(()) => std::task::Poll::Ready(Ok(bytes.len())),
                    Err(error) => std::task::Poll::Ready(Err(std::io::Error::other(error))),
                }
            }
        }
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use futures_util::Sink;
        std::pin::Pin::new(&mut self.get_mut().socket)
            .poll_flush(cx)
            .map_err(std::io::Error::other)
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use futures_util::Sink;
        std::pin::Pin::new(&mut self.get_mut().socket)
            .poll_close(cx)
            .map_err(std::io::Error::other)
    }
}
#[tokio::test]
async fn actual_wss_and_end_to_end_target_tls_preserve_host_verification_and_opaque_bytes() {
    use tokio_rustls::{
        TlsAcceptor, TlsConnector,
        rustls::{
            self, ClientConfig, RootCertStore,
            pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer, ServerName},
        },
    };
    let mut f = Fixture::new(16, 10000, 2).await;
    let old = f.backend.take().unwrap();
    old.abort();
    let _ = old.await;
    let target_identity = rcgen::generate_simple_self_signed(vec!["target.test".into()]).unwrap();
    let target_ca = target_identity.cert.der().clone();
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![target_ca.clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                target_identity.signing_key.serialize_der(),
            )),
        )
        .unwrap();
    let target = TcpListener::bind((f.target.parse::<std::net::IpAddr>().unwrap(), 50000))
        .await
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(server_config));
    let application_bytes = Arc::new(AtomicUsize::new(0));
    let seen = application_bytes.clone();
    let dials = f.dials.clone();
    f.backend = Some(tokio::spawn(async move {
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            let (socket, _) = target.accept().await.unwrap();
            dials.fetch_add(1, Ordering::SeqCst);
            let (acceptor, seen) = (acceptor.clone(), seen.clone());
            jobs.spawn(async move {
                if let Ok(mut tls) = acceptor.accept(socket).await {
                    let mut bytes = [0; 64];
                    while let Ok(count) = tls.read(&mut bytes).await {
                        if count == 0 {
                            break;
                        }
                        seen.fetch_add(count, Ordering::SeqCst);
                        if tls.write_all(&bytes[..count]).await.is_err() {
                            break;
                        }
                    }
                }
            });
        }
    }));
    let outer = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let outer_ca = outer.cert.der().clone();
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![outer_ca.clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(outer.signing_key.serialize_der())),
        )
        .unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = proxy.local_addr().unwrap();
    let upstream = f.server.address;
    let outer_acceptor = TlsAcceptor::from(Arc::new(config));
    let proxy_task = tokio::spawn(async move {
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            let (socket, _) = proxy.accept().await.unwrap();
            let acceptor = outer_acceptor.clone();
            jobs.spawn(async move {
                let mut tls = acceptor.accept(socket).await.unwrap();
                let mut tcp = TcpStream::connect(upstream).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut tls, &mut tcp).await;
            });
        }
    });
    let mut outer_roots = RootCertStore::empty();
    outer_roots.add(outer_ca).unwrap();
    let outer_client = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(outer_roots)
            .with_no_client_auth(),
    );
    let mut target_roots = RootCertStore::empty();
    target_roots.add(target_ca).unwrap();
    let connector = TlsConnector::from(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(target_roots)
            .with_no_client_auth(),
    ));
    for (nonce, hostname, allowed) in [(1, "target.test", true), (2, "wrong.test", false)] {
        let mut request = format!("wss://localhost:{}{}", proxy_address.port(), wire("path"))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            HeaderName::from_bytes(wire("header").as_bytes()).unwrap(),
            f.sign(&f.claims(nonce)).parse().unwrap(),
        );
        let outer_stream = TlsConnector::from(outer_client.clone())
            .connect(
                ServerName::try_from("localhost".to_string()).unwrap(),
                TcpStream::connect(proxy_address).await.unwrap(),
            )
            .await
            .unwrap();
        let (socket, _) = tokio_tungstenite::client_async(request, outer_stream)
            .await
            .unwrap();
        let stream = WsBytes {
            socket,
            pending: Vec::new(),
            position: 0,
        };
        let tls = timeout(
            Duration::from_secs(10),
            connector.connect(ServerName::try_from(hostname.to_string()).unwrap(), stream),
        )
        .await
        .unwrap();
        if allowed {
            let mut tls = tls.unwrap();
            tls.write_all(b"opaque-management-request").await.unwrap();
            tls.flush().await.unwrap();
            let mut bytes = vec![0; 25];
            tls.read_exact(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"opaque-management-request");
            let _ = tls.shutdown().await;
        } else {
            assert!(tls.is_err());
        }
    }
    proxy_task.abort();
    assert_eq!(application_bytes.load(Ordering::SeqCst), 25);
    assert_eq!(f.dials.load(Ordering::SeqCst), 2);
}

async fn raw_upgrade(f: &Fixture, nonce: u64) -> TcpStream {
    let token = f.sign(&f.claims(nonce));
    let mut stream = TcpStream::connect(f.server.address).await.unwrap();
    stream.write_all(format!("GET {} HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{}: {token}\r\n\r\n",wire("path"),wire("header")).as_bytes()).await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0];
        timeout(Duration::from_secs(10), stream.read_exact(&mut b))
            .await
            .unwrap()
            .unwrap();
        head.push(b[0]);
        assert!(head.len() < 8192);
    }
    assert!(
        std::str::from_utf8(&head)
            .unwrap()
            .starts_with("HTTP/1.1 101")
    );
    stream
}
#[tokio::test]
async fn zero_byte_fragments_and_control_floods_cannot_escape_their_connection_budget() {
    let f = Fixture::new(17, 10000, 2).await;
    let mut healthy = f.connect(1).await;
    let mut fragmented = raw_upgrade(&f, 2).await;
    let mut frames = vec![0x02, 0x80, 1, 2, 3, 4];
    for _ in 0..3000 {
        frames.extend_from_slice(&[0, 0x80, 1, 2, 3, 4]);
    }
    let _ = fragmented.write_all(&frames).await;
    let mut output = Vec::new();
    let _ = timeout(Duration::from_secs(2), fragmented.read_to_end(&mut output))
        .await
        .unwrap();
    drop(fragmented);
    timeout(Duration::from_secs(2), async {
        loop {
            if f.server.relay.snapshot()["connections"] == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut control = raw_upgrade(&f, 3).await;
    let frames = [0x89, 0x80, 1, 2, 3, 4].repeat(140);
    let _ = control.write_all(&frames).await;
    let mut output = Vec::new();
    let _ = timeout(Duration::from_secs(2), control.read_to_end(&mut output))
        .await
        .unwrap();
    drop(control);
    healthy
        .send(Message::Binary(b"healthy-after-flood".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(read_bytes(&mut healthy, 19).await, b"healthy-after-flood");
    assert!(f.server.relay.snapshot()["memoryUsed"].as_u64().unwrap() < 512 * 1024);
    let _ = healthy.close(None).await;
    drop(healthy);
    f.wait_empty().await;
}
