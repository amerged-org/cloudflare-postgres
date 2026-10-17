// SPDX-License-Identifier: Apache-2.0
//! A plain-HTTP Cloudflare API double that answers the agent's requests.
use crate::api::ControlApi;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
/// A plain-HTTP client for a local double; any HTTPS use fails closed.
pub fn plain_http(timeout: Duration) -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .tls_certs_only(Vec::new())
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .unwrap()
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
