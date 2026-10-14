// SPDX-License-Identifier: Apache-2.0
//! Private control plane. TLS key remains in memory; its public attestation is node-verified.
use crate::{
    Error, archiver, now, private,
    protocol::{self, text},
    runtime::{Identity, Runtime},
    sha256,
};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    sync::{Mutex, Semaphore},
};
use tokio_rustls::TlsAcceptor;

const MAXIMUM: usize = 128 * 1024;
struct State {
    runtime: Mutex<Runtime>,
    backup: Mutex<()>,
}

fn environment(name: &str) -> Result<String, Error> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or(Error("pool_identity_missing"))
}
pub async fn serve() -> Result<(), Error> {
    private::protect_process_memory()?;
    use rcgen::PublicKeyData;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
    let ip = environment("PGCF_POOL_POD_IP")?;
    let workload_probe = crate::isolation::child()?;
    let listen_ip = ip
        .parse::<std::net::IpAddr>()
        .map_err(|_| Error("pool_identity_invalid"))?;
    let identity = rcgen::generate_simple_self_signed(vec!["pgcf-pool.invalid".into(), ip.clone()])
        .map_err(|_| Error("pool_key_unavailable"))?;
    let key_pem = identity.signing_key.serialize_pem();
    let public_pem = identity.signing_key.public_key_pem();
    let cert_pem = identity.cert.pem();
    let certs = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error("pool_key_unavailable"))?;
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
        .map_err(|_| Error("pool_key_unavailable"))?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|_| Error("pool_key_unavailable"))?;
    let executable = std::env::current_exe().map_err(|_| Error("pool_executable_unavailable"))?;
    let bytes = fs::read(executable).map_err(|_| Error("pool_executable_unavailable"))?;
    let runtime_identity = Identity {
        pod: environment("PGCF_POOL_POD_UID")?,
        ip,
        node: environment("PGCF_POOL_NODE_UID")?,
        image: environment("PGCF_POOL_POSTGRES_IMAGE_SHA256")?,
        executable: sha256(&bytes),
        key: sha256(&identity.signing_key.subject_public_key_info()),
    };
    let attestation = json!({"v":1,"pool_pod_uid":runtime_identity.pod,"node_uid":runtime_identity.node,
        "supervisor_sha256":runtime_identity.executable,"supervisor_key_sha256":runtime_identity.key,
        "supervisor_public_key_pem":public_pem,"supervisor_certificate_pem":cert_pem,"workload_probe":workload_probe,"observed_at":now()});
    private::replace(
        Path::new(protocol::constant("attestation_file")?),
        &serde_json::to_vec(&attestation).map_err(|_| Error("pool_attestation_invalid"))?,
    )?;
    let state = Arc::new(State {
        runtime: Mutex::new(Runtime::new(
            runtime_identity,
            protocol::permissions()?,
            protocol::storage_trust()?,
        )),
        backup: Mutex::new(()),
    });
    let path = Path::new(protocol::constant("agent_socket")?);
    if path.symlink_metadata().is_ok() {
        return Err(Error("pool_agent_socket_exists"));
    }
    let agent = UnixListener::bind(path).map_err(|_| Error("pool_agent_unavailable"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| Error("pool_agent_unavailable"))?;
    let port = pgcf_native_protocol::pool::constant("supervisor_port")
        .as_u64()
        .ok_or(Error("pool_protocol_missing"))?;
    let tcp = TcpListener::bind((listen_ip, port as u16))
        .await
        .map_err(|_| Error("pool_listener_unavailable"))?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let connections = Arc::new(Semaphore::new(16));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| Error("pool_signal_unavailable"))?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|_| Error("pool_signal_unavailable"))?;
    let mut monitor = tokio::time::interval(Duration::from_millis(100));
    let result = loop {
        tokio::select! {
            _ = term.recv() => break Ok(()),
            _ = interrupt.recv() => break Ok(()),
            _ = monitor.tick() => { state.runtime.lock().await.check_running()?; },
            incoming = tcp.accept() => {
                let (stream, _) = incoming.map_err(|_| Error("pool_listener_unavailable"))?;
                let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { continue; };
                let acceptor = acceptor.clone(); let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok(mut stream)) = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(stream)).await {
                        let result = tokio::time::timeout(Duration::from_secs(5), http_request(&mut stream)).await;
                        let reply = match result {
                            Ok(Ok((method, path, body))) => control(&state, &method, &path, body).await,
                            _ => Err(Error("pool_request_invalid")),
                        };
                        let (status, value) = match reply { Ok(value) => (200, value), Err(error) => (409, json!({"error":error.0})) };
                        let _ = http_reply(&mut stream, status, value).await;
                    }
                });
            }
            incoming = agent.accept() => {
                let (mut stream, _) = incoming.map_err(|_| Error("pool_agent_unavailable"))?;
                let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else { continue; };
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let _permit = permit;
                    let result = async {
                        let peer = stream.peer_cred().map_err(|_| Error("pool_agent_peer_refused"))?;
                        if peer.uid() != 0 || peer.pid() != Some(0) { return Err(Error("pool_agent_peer_refused")); }
                        let bytes = tokio::time::timeout(Duration::from_secs(5), bounded(&mut stream, MAXIMUM)).await.map_err(|_| Error("pool_request_timeout"))??;
                        let signal = serde_json::from_slice(&bytes).map_err(|_| Error("pool_request_invalid"))?;
                        let mut runtime = state.runtime.lock().await;
                        runtime.mounted(signal)?;
                        Ok(runtime.start().await?.unwrap_or_else(|| json!({"accepted":true,"waiting":true})))
                    }.await;
                    let value = result.unwrap_or_else(|error| json!({"error":error.0}));
                    if let Ok(bytes) = serde_json::to_vec(&value) { let _ = stream.write_all(&bytes).await; }
                });
            }
        }
    };
    // Graceful deletion stops the postmaster. The node agent still owns physical release proof.
    if let Some(report) = state.runtime.lock().await.shutdown().await? {
        private::replace(
            Path::new("/pgcf/control/final-report.json"),
            &serde_json::to_vec(&report).map_err(|_| Error("pool_report_invalid"))?,
        )?;
    }
    result
}

async fn control(state: &State, method: &str, path: &str, body: Value) -> Result<Value, Error> {
    if method == "GET" && path == "/healthz" {
        return Ok(json!({"alive":true}));
    }
    if method != "POST" {
        return Err(Error("pool_request_invalid"));
    }
    if path == "/backup" {
        let body = protocol::valid("PoolBackupRequest", body)?;
        let name = text(&body, "backup_name")?.to_owned();
        let mut request = body.clone();
        request
            .as_object_mut()
            .ok_or(Error("pool_request_invalid"))?
            .remove("backup_name");
        let _backup = state
            .backup
            .try_lock()
            .map_err(|_| Error("pool_backup_in_progress"))?;
        let command = state.runtime.lock().await.backup_command(&request, &name)?;
        return archiver::request(command).await;
    }
    let _backup = if path == "/stop" {
        Some(state.backup.lock().await)
    } else {
        None
    };
    let mut runtime = state.runtime.lock().await;
    match path {
        "/bundle" => {
            runtime.bundle(body)?;
            Ok(runtime
                .start()
                .await?
                .unwrap_or_else(|| json!({"accepted":true,"waiting":true})))
        }
        "/status" => {
            runtime.authorize(&body)?;
            runtime.status()
        }
        "/stop" => runtime.stop(&body).await,
        _ => Err(Error("pool_request_invalid")),
    }
}
async fn bounded(stream: &mut (impl AsyncRead + Unpin), maximum: usize) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    stream
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error("pool_request_invalid"))?;
    if bytes.len() > maximum {
        return Err(Error("pool_request_oversized"));
    }
    Ok(bytes)
}
async fn http_request(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<(String, String, Value), Error> {
    let mut bytes = Vec::new();
    let (method, path, header_length, length) = loop {
        if bytes.len() > MAXIMUM {
            return Err(Error("pool_request_oversized"));
        }
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut request = httparse::Request::new(&mut headers);
        if let httparse::Status::Complete(at) = request
            .parse(&bytes)
            .map_err(|_| Error("pool_request_invalid"))?
        {
            if request.version != Some(1) {
                return Err(Error("pool_request_invalid"));
            }
            let method = request
                .method
                .ok_or(Error("pool_request_invalid"))?
                .to_owned();
            let path = request
                .path
                .ok_or(Error("pool_request_invalid"))?
                .to_owned();
            let lengths: Vec<_> = request
                .headers
                .iter()
                .filter(|h| h.name.eq_ignore_ascii_case("content-length"))
                .collect();
            if lengths.len() > 1
                || request
                    .headers
                    .iter()
                    .any(|h| h.name.eq_ignore_ascii_case("transfer-encoding"))
            {
                return Err(Error("pool_request_invalid"));
            }
            let length = lengths
                .first()
                .map(|h| {
                    std::str::from_utf8(h.value)
                        .ok()
                        .and_then(|v| v.parse::<usize>().ok())
                })
                .unwrap_or(Some(0))
                .ok_or(Error("pool_request_invalid"))?;
            if length > MAXIMUM
                || at > 8192
                || (method == "POST"
                    && !request.headers.iter().any(|h| {
                        h.name.eq_ignore_ascii_case("content-type")
                            && h.value == b"application/json"
                    }))
            {
                return Err(Error("pool_request_invalid"));
            }
            break (method, path, at, length);
        }
        if bytes.len() >= 8192 {
            return Err(Error("pool_request_oversized"));
        }
        let mut chunk = [0; 4096];
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| Error("pool_request_invalid"))?;
        if count == 0 {
            return Err(Error("pool_request_invalid"));
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    if bytes.len() > header_length + length {
        return Err(Error("pool_request_invalid"));
    }
    let received = bytes.len();
    bytes.resize(header_length + length, 0);
    stream
        .read_exact(&mut bytes[received..])
        .await
        .map_err(|_| Error("pool_request_invalid"))?;
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_length..])
            .map_err(|_| Error("pool_request_invalid"))?
    };
    Ok((method, path, body))
}
async fn http_reply(
    stream: &mut (impl AsyncWrite + Unpin),
    status: u16,
    value: Value,
) -> Result<(), Error> {
    let bytes = serde_json::to_vec(&value).map_err(|_| Error("pool_reply_invalid"))?;
    let header = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Conflict" },
        bytes.len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|_| Error("pool_reply_unavailable"))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| Error("pool_reply_unavailable"))?;
    stream
        .shutdown()
        .await
        .map_err(|_| Error("pool_reply_unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn control_http_reads_fragmented_body_and_refuses_duplicate_lengths() {
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        let task = tokio::spawn(async move { http_request(&mut server).await });
        client.write_all(b"POST /status HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        client.write_all(b"{\"v\":1}").await.unwrap();
        let (method, path, value) = task.await.unwrap().unwrap();
        assert_eq!(
            (method.as_str(), path.as_str(), value),
            ("POST", "/status", json!({"v":1}))
        );
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        client.write_all(b"POST /status HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 0\r\nContent-Length: 7\r\n\r\n").await.unwrap();
        assert_eq!(
            http_request(&mut server).await,
            Err(Error("pool_request_invalid"))
        );
    }
}
