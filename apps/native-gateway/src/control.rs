// SPDX-License-Identifier: Apache-2.0
use crate::{
    hold::WakeQueue,
    kubernetes::{FenceState, retirement_ready},
    sessions::{Action, SharedSessions},
    telemetry::GatewayMeasurements,
    transport::Config,
};
use pgcf_native_protocol::{
    scoped_tokens,
    wake::{self, WakePoll, WakeResult},
    wire,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{RwLock, Semaphore},
    time::timeout,
};
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
pub fn timestamp(millis: u64) -> String {
    let time = time::OffsetDateTime::from_unix_timestamp_nanos(millis as i128 * 1_000_000)
        .expect("valid timestamp");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        time.month() as u8,
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
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
    fn body_forbidden(&self) -> bool {
        self.has("transfer-encoding")
            || (self.has("content-length") && self.one("content-length") != Some("0"))
    }
}
pub async fn read_head(
    stream: &mut TcpStream,
) -> Result<HttpHead, Box<dyn std::error::Error + Send + Sync>> {
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
pub async fn reply(
    stream: &mut TcpStream,
    status: u16,
    body: Value,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    reply_bytes(
        stream,
        status,
        "application/json",
        &serde_json::to_vec(&body)?,
    )
    .await
}
pub async fn reply_text(
    stream: &mut TcpStream,
    status: u16,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    reply_bytes(stream, status, "text/plain", body.as_bytes()).await
}
async fn reply_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
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
pub struct Control {
    pub config: Arc<Config>,
    pub pod: String,
    pub fences: Arc<RwLock<FenceState>>,
    pub sessions: SharedSessions,
    pub measurements: Arc<Mutex<GatewayMeasurements>>,
    pub wakes: Arc<WakeQueue>,
    control_capacity: Semaphore,
    activity_capacity: Semaphore,
    /// The controller's wake long-polls, apart from the short control requests.
    poll_capacity: Semaphore,
    activity_replay: Mutex<HashMap<String, u64>>,
}
impl Control {
    pub fn new(
        config: Arc<Config>,
        pod: String,
        fences: Arc<RwLock<FenceState>>,
        sessions: SharedSessions,
        measurements: Arc<Mutex<GatewayMeasurements>>,
        wakes: Arc<WakeQueue>,
    ) -> Self {
        Self {
            config,
            pod,
            fences,
            sessions,
            measurements,
            wakes,
            control_capacity: Semaphore::new(32),
            activity_capacity: Semaphore::new(32),
            poll_capacity: Semaphore::new(4),
            activity_replay: Mutex::new(HashMap::new()),
        }
    }
    /// The answer to a control-port request, or none for a request that is not one. Only a wake
    /// result has a body; it is read from `stream`.
    pub async fn handle(&self, head: &HttpHead, stream: &mut TcpStream) -> Option<(u16, Value)> {
        if head.path == wire("activityPath") {
            return Some(self.activity(head).await);
        }
        if head.path == wake::POLL_PATH {
            return Some(self.wakes_poll(head).await);
        }
        if head.path == wake::RESULT_PATH {
            return Some(self.wake_result(head, stream).await);
        }
        let action = head.path.strip_prefix(wire("controlPathPrefix"))?;
        if !["begin", "status", "close", "release", "retire"].contains(&action) {
            return Some((404, json!({"error":"control_not_found"})));
        }
        if head.method != "POST" {
            return Some((405, json!({"error":"control_method"})));
        }
        if head.body_forbidden() {
            return Some((400, json!({"error":"control_body_forbidden"})));
        }
        let Some(token) = head.one(wire("controlHeader")) else {
            return Some((401, json!({"error":"control_denied"})));
        };
        let Ok(_permit) = self.control_capacity.try_acquire() else {
            return Some((503, json!({"error":"control_unavailable"})));
        };
        let Some(claims) = scoped_tokens::control(
            token,
            &self.config.keyring.keys,
            &self.config.region,
            &self.pod,
            action,
            now(),
        ) else {
            return Some((401, json!({"error":"control_denied"})));
        };
        Some(self.control_claims(action, &claims).await)
    }
    async fn control_claims(&self, action: &str, claims: &Value) -> (u16, Value) {
        let database = claims["database"].as_str().unwrap();
        let current = self.fences.read().await;
        if !current.synchronized() {
            return (503, json!({"error":"fences_unsynchronized"}));
        }
        let Some(fence) = current.records.get(database).cloned() else {
            return (409, json!({"error":"control_intent_mismatch"}));
        };
        let intent = &fence.intent;
        if claims["operation"] != intent.operation
            || claims["revision"] != intent.revision
            || (if action == "retire" {
                intent.mode != "retired"
            } else {
                intent.mode == "retired"
                    || (if action == "release" {
                        intent.mode != "running"
                    } else {
                        action != "status" && intent.mode != "quiesce"
                    })
            })
        {
            return (409, json!({"error":"control_intent_mismatch"}));
        }
        drop(current);
        if action == "begin" {
            self.sessions
                .lock()
                .unwrap()
                .signal(database, Action::Quiesce);
        }
        if action == "close" {
            let registry = self.sessions.lock().unwrap();
            if registry.counts(database).busy == 0 {
                registry.signal(database, Action::CloseIdle);
            }
        }
        if action == "begin" || action == "close" {
            // Each session rechecks its own protocol/partial-frame state before
            // idle closure. A busy or uncertain session is never forced closed.
            for _ in 0..100 {
                let counts = self.sessions.lock().unwrap().counts(database);
                if (action == "begin" && counts.connections == counts.authenticated)
                    || (action == "close" && (counts.connections == 0 || counts.busy > 0))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let current = self.fences.read().await;
        if !current.synchronized() {
            return (503, json!({"error":"fences_unsynchronized"}));
        }
        if current
            .records
            .get(database)
            .is_none_or(|v| v.intent != *intent || v.uid != fence.uid)
        {
            return (409, json!({"error":"control_intent_mismatch"}));
        }
        let counts = self.sessions.lock().unwrap().counts(database);
        if action == "retire" && !retirement_ready(&fence, counts.connections) {
            return (409, json!({"error":"retirement_sessions_remain"}));
        }
        let status = if intent.mode == "retired" {
            "retired"
        } else if intent.mode == "running" {
            "running"
        } else if action == "close" && counts.connections == 0 {
            "closed"
        } else if counts.busy == 0 {
            "idle"
        } else {
            "busy"
        };
        (
            200,
            json!({"database":database,"operation":intent.operation,"revision":intent.revision,"mode":intent.mode,"pod":self.pod,"status":status,"connections":counts.connections,"busyConnections":counts.busy,"pendingDials":counts.pending_dials}),
        )
    }
    fn wake_token(&self, head: &HttpHead, action: &str) -> bool {
        wake::verify_poll(
            head.one(wake::POLL_HEADER),
            &self.config.keyring.keys,
            &self.config.region,
            &self.pod,
            action,
            now(),
        )
        .is_some()
    }
    /// The controller's long-poll: the queued wakes as soon as there are any, or none after
    /// `POLL_HOLD_MS`.
    async fn wakes_poll(&self, head: &HttpHead) -> (u16, Value) {
        if head.method != "POST" {
            return (405, json!({"error":"wake_method"}));
        }
        if head.body_forbidden() {
            return (400, json!({"error":"wake_body_forbidden"}));
        }
        if !head.has(wake::POLL_HEADER) {
            return (401, json!({"error":"wake_denied"}));
        }
        let Ok(_permit) = self.poll_capacity.try_acquire() else {
            return (503, json!({"error":"wake_poll_capacity"}));
        };
        if !self.wake_token(head, wake::POLL_ACTION) {
            return (401, json!({"error":"wake_denied"}));
        }
        let wakes = self
            .wakes
            .poll(Duration::from_millis(wake::POLL_HOLD_MS))
            .await;
        (
            200,
            json!(WakePoll {
                pod: self.pod.clone(),
                wakes
            }),
        )
    }
    /// The controller's result for a wake it took: a label, or the refusal of its connections.
    async fn wake_result(&self, head: &HttpHead, stream: &mut TcpStream) -> (u16, Value) {
        if head.method != "POST" {
            return (405, json!({"error":"wake_method"}));
        }
        let Some(length) = head
            .one("content-length")
            .filter(|_| !head.has("transfer-encoding"))
            .and_then(|length| length.parse::<usize>().ok())
            .filter(|length| *length <= wake::RESULT_MAX_BYTES)
        else {
            return (400, json!({"error":"wake_result_invalid"}));
        };
        if !head.has(wake::POLL_HEADER) {
            return (401, json!({"error":"wake_denied"}));
        }
        let Ok(_permit) = self.control_capacity.try_acquire() else {
            return (503, json!({"error":"control_unavailable"}));
        };
        if !self.wake_token(head, wake::RESULT_ACTION) {
            return (401, json!({"error":"wake_denied"}));
        }
        let mut body = head.prefix[head.end..].to_vec();
        if body.len() > length {
            return (400, json!({"error":"wake_result_invalid"}));
        }
        let mut chunk = [0; 1024];
        while body.len() < length {
            match timeout(Duration::from_secs(5), stream.read(&mut chunk)).await {
                Ok(Ok(read)) if read > 0 && body.len() + read <= length => {
                    body.extend_from_slice(&chunk[..read]);
                }
                _ => return (400, json!({"error":"wake_result_invalid"})),
            }
        }
        let Some(result) = serde_json::from_slice::<WakeResult>(&body)
            .ok()
            .filter(WakeResult::valid)
        else {
            return (400, json!({"error":"wake_result_invalid"}));
        };
        if self.wakes.result(&result) {
            (200, json!({}))
        } else {
            (404, json!({"error":"wake_unknown"}))
        }
    }
    async fn activity(&self, head: &HttpHead) -> (u16, Value) {
        if head.method != "POST" {
            return (405, json!({"error":"activity_method"}));
        }
        if head.body_forbidden() {
            return (400, json!({"error":"activity_body_forbidden"}));
        }
        let Some(token) = head.one(wire("activityHeader")) else {
            return (401, json!({"error":"activity_denied"}));
        };
        let Ok(_permit) = self.activity_capacity.try_acquire() else {
            return (503, json!({"error":"activity_unavailable"}));
        };
        let Some(claims) = scoped_tokens::activity(
            token,
            &self.config.keyring.keys,
            &self.config.region,
            &self.pod,
            now(),
        ) else {
            return (401, json!({"error":"activity_denied"}));
        };
        let database = claims["database"].as_str().unwrap();
        let current = self.fences.read().await;
        if !current.synchronized() {
            return (503, json!({"error":"fences_unsynchronized"}));
        }
        let Some(intent) = current.records.get(database).map(|v| &v.intent) else {
            return (409, json!({"error":"activity_revision_mismatch"}));
        };
        if claims["revision"] != intent.revision {
            return (409, json!({"error":"activity_revision_mismatch"}));
        }
        let time = now();
        let nonce = claims["nonce"].as_str().unwrap().to_string();
        let expiry = claims["exp"].as_u64().unwrap() * 1000;
        if time >= expiry {
            return (401, json!({"error":"activity_denied"}));
        }
        {
            let mut replay = self.activity_replay.lock().unwrap();
            replay.retain(|_, expiry| *expiry > time);
            if replay.contains_key(&nonce) {
                return (401, json!({"error":"activity_replayed"}));
            }
            if replay.len() >= 4096 {
                return (503, json!({"error":"activity_replay_capacity"}));
            }
            replay.insert(nonce, expiry);
        }
        let counts = self.sessions.lock().unwrap().counts(database);
        let mut report = self.measurements.lock().unwrap().read(database);
        let output = report.as_object_mut().expect("measurement object");
        for (key, value) in [
            ("database", json!(database)),
            ("revision", json!(intent.revision)),
            ("region", json!(self.config.region)),
            ("pod", json!(self.pod)),
            ("connections", json!(counts.connections)),
            ("authenticatedConnections", json!(counts.authenticated)),
            ("busyConnections", json!(counts.authenticated_busy)),
            ("pendingDials", json!(counts.pending_dials)),
        ] {
            output.insert(key.into(), value);
        }
        (200, report)
    }
}
