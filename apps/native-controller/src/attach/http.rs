// SPDX-License-Identifier: Apache-2.0
//! The agent's HTTP/1.1 listener: `POST /v1/<action>`, one token header, one bounded JSON body,
//! one request per connection, at most `WORKERS` requests at once.
use pgcf_native_controller::attach_protocol::{Action, ERRORS, HEADER, MAX_BODY_BYTES};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

pub(crate) const WORKERS: usize = 4;
const MAX_HEAD_BYTES: usize = 8192;
const MAX_HEADERS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) type Handler =
    dyn Fn(Action, &str, &[u8]) -> Result<Vec<u8>, &'static str> + Send + Sync;

/// The HTTP status a refusal code is answered with.
pub(crate) fn status_of(code: &str) -> u16 {
    match code {
        "invalid" => 400,
        "denied" => 401,
        "busy" | "keys_unavailable" | "unsupported_platform" => 503,
        code if ERRORS.contains(&code) => 409,
        _ => 500,
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush());
}

fn refuse(stream: &mut TcpStream, status: u16, code: &str) {
    respond(
        stream,
        status,
        format!(r#"{{"error":"{code}"}}"#).as_bytes(),
    );
}

/// A parsed request: the action, its one token and its body.
struct Request {
    action: Action,
    token: String,
    body: Vec<u8>,
}

/// Reads one request; `Err` carries the status and code to refuse it with.
fn read(stream: &mut TcpStream) -> Result<Request, (u16, &'static str)> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let (head, action, token, length) = loop {
        let count = stream.read(&mut chunk).map_err(|_| (400, "invalid"))?;
        if count == 0 {
            return Err((400, "invalid"));
        }
        buffer.extend_from_slice(&chunk[..count]);
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut request = httparse::Request::new(&mut headers);
        match request.parse(&buffer) {
            Ok(httparse::Status::Complete(head)) => {
                let action = match request.path.map(Action::from_path) {
                    Some(Some(action)) => action,
                    _ => return Err((404, "invalid")),
                };
                if request.method != Some("POST") {
                    return Err((405, "invalid"));
                }
                let mut tokens = request
                    .headers
                    .iter()
                    .filter(|header| header.name.eq_ignore_ascii_case(HEADER));
                let token = match (tokens.next(), tokens.next()) {
                    (Some(header), None) => std::str::from_utf8(header.value)
                        .map_err(|_| (401, "denied"))?
                        .to_string(),
                    _ => return Err((401, "denied")),
                };
                if request
                    .headers
                    .iter()
                    .any(|header| header.name.eq_ignore_ascii_case("transfer-encoding"))
                {
                    return Err((400, "invalid"));
                }
                let mut lengths = request
                    .headers
                    .iter()
                    .filter(|header| header.name.eq_ignore_ascii_case("content-length"));
                let length: usize = match (lengths.next(), lengths.next()) {
                    (Some(header), None) => std::str::from_utf8(header.value)
                        .ok()
                        .and_then(|value| value.trim().parse().ok())
                        .ok_or((400, "invalid"))?,
                    (None, _) => return Err((411, "invalid")),
                    _ => return Err((400, "invalid")),
                };
                if length > MAX_BODY_BYTES {
                    return Err((413, "invalid"));
                }
                break (head, action, token, length);
            }
            Ok(httparse::Status::Partial) if buffer.len() < MAX_HEAD_BYTES => {}
            _ => return Err((400, "invalid")),
        }
    };
    let mut body = buffer.split_off(head);
    if body.len() > length {
        return Err((400, "invalid"));
    }
    while body.len() < length {
        let count = stream.read(&mut chunk).map_err(|_| (400, "invalid"))?;
        if count == 0 || body.len() + count > length {
            return Err((400, "invalid"));
        }
        body.extend_from_slice(&chunk[..count]);
    }
    Ok(Request {
        action,
        token,
        body,
    })
}

fn connection(mut stream: TcpStream, handler: &Handler, busy: bool) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    match read(&mut stream) {
        Err((status, code)) => refuse(&mut stream, status, code),
        Ok(_) if busy => refuse(&mut stream, 503, "busy"),
        Ok(request) => match handler(request.action, &request.token, &request.body) {
            Ok(body) => respond(&mut stream, 200, &body),
            Err(code) => refuse(&mut stream, status_of(code), code),
        },
    }
}

/// Accepts forever. Each connection runs on its own thread while fewer than `WORKERS` run;
/// beyond that the request is read and answered `busy` on the accepting thread.
pub(crate) fn serve(listener: TcpListener, handler: Arc<Handler>) {
    let running = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if running.fetch_add(1, Ordering::SeqCst) >= WORKERS {
            running.fetch_sub(1, Ordering::SeqCst);
            connection(stream, &*handler, true);
            continue;
        }
        let (handler, done) = (handler.clone(), running.clone());
        let spawned = std::thread::Builder::new()
            .name("attach-request".into())
            .spawn(move || {
                connection(stream, &*handler, false);
                done.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            running.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{SocketAddr, TcpStream},
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn start(handler: Arc<Handler>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || serve(listener, handler));
        address
    }
    fn exchange(address: SocketAddr, request: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response[9..12].parse().unwrap();
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }
    fn post(path: &str, headers: &str, body: &str) -> String {
        format!(
            "POST {path} HTTP/1.1\r\nhost: agent\r\n{headers}content-length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn only_post_v1_actions_with_a_bounded_json_body_and_one_token_header_are_served() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let address = start(Arc::new(move |action, token, body| {
            seen.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::to_vec(&serde_json::json!({
                "action": action.name(), "token": token, "body": String::from_utf8_lossy(body),
            }))
            .unwrap())
        }));
        let (status, body) = exchange(
            address,
            &post("/v1/attach", "x-pgcf-attach: pa1.a.b\r\n", r#"{"a":1}"#),
        );
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"action": "attach", "token": "pa1.a.b", "body": "{\"a\":1}"})
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let refused = [
            (
                "GET /v1/attach HTTP/1.1\r\nhost: agent\r\nx-pgcf-attach: t\r\n\r\n".to_string(),
                405,
                "invalid",
            ),
            (post("/v1/mount", "x-pgcf-attach: t\r\n", "{}"), 404, "invalid"),
            (post("/v1/hold", "", "{}"), 401, "denied"),
            (
                post("/v1/hold", "x-pgcf-attach: t\r\nx-pgcf-attach: u\r\n", "{}"),
                401,
                "denied",
            ),
            (
                "POST /v1/hold HTTP/1.1\r\nhost: agent\r\nx-pgcf-attach: t\r\ncontent-length: 8193\r\n\r\n"
                    .to_string(),
                413,
                "invalid",
            ),
            (
                "POST /v1/hold HTTP/1.1\r\nhost: agent\r\nx-pgcf-attach: t\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n"
                    .to_string(),
                400,
                "invalid",
            ),
            (
                "POST /v1/hold HTTP/1.1\r\nhost: agent\r\nx-pgcf-attach: t\r\n\r\n".to_string(),
                411,
                "invalid",
            ),
        ];
        for (request, status, code) in refused {
            let (answered, body) = exchange(address, &request);
            assert_eq!(
                (answered, body),
                (status, format!(r#"{{"error":"{code}"}}"#)),
                "{request}"
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn refusals_answer_their_status_and_error_code() {
        let address = start(Arc::new(|_, token, _| {
            Err(match token {
                "denied" => "denied",
                "invalid" => "invalid",
                "busy" => "busy",
                "keys_unavailable" => "keys_unavailable",
                "unsupported_platform" => "unsupported_platform",
                "holder_busy" => "holder_busy",
                "release_timeout" => "release_timeout",
                _ => "io_failed",
            })
        }));
        for (code, status) in [
            ("denied", 401),
            ("invalid", 400),
            ("busy", 503),
            ("keys_unavailable", 503),
            ("unsupported_platform", 503),
            ("holder_busy", 409),
            ("release_timeout", 409),
            ("io_failed", 500),
        ] {
            let header = format!("x-pgcf-attach: {code}\r\n");
            assert_eq!(
                exchange(address, &post("/v1/inspect", &header, "{}")),
                (status, format!(r#"{{"error":"{code}"}}"#))
            );
            assert_eq!(status_of(code), status);
        }
    }
}
