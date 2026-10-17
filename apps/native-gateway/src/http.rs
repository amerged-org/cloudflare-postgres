// SPDX-License-Identifier: Apache-2.0
//! The HTTP the gateway speaks with cloudflared: one request head per connection, and plain
//! answers that close it.
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
type Failure = Box<dyn std::error::Error + Send + Sync>;
/// Wall-clock milliseconds since the Unix epoch.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
pub struct HttpHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub prefix: Vec<u8>,
    pub end: usize,
}
impl HttpHead {
    pub fn one(&self, name: &str) -> Option<&str> {
        let mut values = self
            .headers
            .iter()
            .filter(|v| v.0.eq_ignore_ascii_case(name));
        let value = values.next()?.1.as_str();
        if values.next().is_some() {
            None
        } else {
            Some(value)
        }
    }
    pub fn has(&self, name: &str) -> bool {
        self.headers.iter().any(|v| v.0.eq_ignore_ascii_case(name))
    }
    pub fn count(&self, name: &str) -> usize {
        self.headers
            .iter()
            .filter(|v| v.0.eq_ignore_ascii_case(name))
            .count()
    }
}
pub async fn read_head(stream: &mut TcpStream) -> Result<HttpHead, Failure> {
    let mut prefix = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut parsed = httparse::Request::new(&mut headers);
        match parsed.parse(&prefix)? {
            httparse::Status::Complete(end) => {
                if end > 16 * 1024 {
                    return Err("HTTP headers too large".into());
                }
                let method = parsed.method.ok_or("HTTP method missing")?.to_string();
                let path = parsed.path.ok_or("HTTP path missing")?.to_string();
                let headers = parsed
                    .headers
                    .iter()
                    .map(|h| {
                        Ok((
                            h.name.to_ascii_lowercase(),
                            std::str::from_utf8(h.value)?.to_string(),
                        ))
                    })
                    .collect::<Result<Vec<_>, std::str::Utf8Error>>()?;
                return Ok(HttpHead {
                    method,
                    path,
                    headers,
                    prefix,
                    end,
                });
            }
            httparse::Status::Partial => {
                if prefix.len() >= 16 * 1024 {
                    return Err("HTTP headers too large".into());
                }
            }
        }
        let length = stream.read(&mut chunk).await?;
        if length == 0 {
            return Err("HTTP connection closed".into());
        }
        prefix.extend_from_slice(&chunk[..length]);
    }
}
pub async fn reply(stream: &mut TcpStream, status: u16, body: Value) -> Result<(), Failure> {
    reply_bytes(
        stream,
        status,
        "application/json",
        &serde_json::to_vec(&body)?,
    )
    .await
}
pub async fn reply_text(stream: &mut TcpStream, status: u16, body: &str) -> Result<(), Failure> {
    reply_bytes(stream, status, "text/plain", body.as_bytes()).await
}
async fn reply_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), Failure> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    timeout(Duration::from_secs(5), async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(body).await?;
        stream.shutdown().await
    })
    .await??;
    Ok(())
}
