// SPDX-License-Identifier: Apache-2.0
use crate::constant;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Event {
    NeedMore,
    Ssl,
    Gss,
    Cancel,
    Error {
        sqlstate: String,
        message: String,
    },
    Startup {
        protocol: Protocol,
        params: Vec<(String, String)>,
        user: String,
        database: String,
        raw: Vec<u8>,
        rest: Vec<u8>,
    },
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Protocol {
    major: u16,
    minor: u16,
}
fn error(message: &str) -> Event {
    Event::Error {
        sqlstate: "08P01".into(),
        message: message.into(),
    }
}
pub struct StartupReader {
    buffer: Vec<u8>,
    maximum: usize,
    ssl: bool,
    gss: bool,
    finished: bool,
}
impl Default for StartupReader {
    fn default() -> Self {
        Self::new(constant("DEFAULT_MAX_BUFFERED") as usize)
    }
}
impl StartupReader {
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }
    pub fn new(maximum: usize) -> Self {
        assert!(maximum >= constant("STARTUP_MAX_LENGTH") as usize);
        Self {
            buffer: Vec::new(),
            maximum,
            ssl: false,
            gss: false,
            finished: false,
        }
    }
    pub fn push(&mut self, chunk: &[u8]) -> Event {
        if self.finished {
            return error("startup already processed");
        }
        if chunk.len() > self.maximum - self.buffer.len() {
            return self.finish(error("too much data before startup"));
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() < 4 {
            return Event::NeedMore;
        }
        let length = u32::from_be_bytes(self.buffer[..4].try_into().unwrap()) as usize;
        if length < constant("STARTUP_MIN_LENGTH") as usize
            || length > constant("STARTUP_MAX_LENGTH") as usize
        {
            return self.finish(error("invalid length of startup packet"));
        }
        if self.buffer.len() < 8 {
            return Event::NeedMore;
        }
        let code = u32::from_be_bytes(self.buffer[4..8].try_into().unwrap()) as u64;
        if code == constant("SSL_REQUEST_CODE") || code == constant("GSSENC_REQUEST_CODE") {
            let ssl = code == constant("SSL_REQUEST_CODE");
            if length != 8 {
                return self.finish(error("invalid length of startup packet"));
            }
            if (if ssl { self.ssl } else { self.gss })
                || self.ssl as u64 + self.gss as u64 >= constant("MAX_PRELUDES")
            {
                return self.finish(error("too many encryption requests"));
            }
            if ssl {
                self.ssl = true;
            } else {
                self.gss = true;
            }
            self.buffer.drain(..8);
            return if ssl { Event::Ssl } else { Event::Gss };
        }
        if code == constant("CANCEL_REQUEST_CODE") {
            if !(constant("CANCEL_MIN_LENGTH")..=constant("CANCEL_MAX_LENGTH"))
                .contains(&(length as u64))
            {
                return self.finish(error("invalid length of cancel request"));
            }
            if self.buffer.len() < length {
                return Event::NeedMore;
            }
            return self.finish(Event::Cancel);
        }
        let major = (code >> 16) as u16;
        let minor = (code & 65535) as u16;
        if major != 3 {
            return self.finish(Event::Error {
                sqlstate: "0A000".into(),
                message: format!(
                    "unsupported frontend protocol {major}.{minor}: server supports 3.0 to 3.x"
                ),
            });
        }
        if self.buffer.len() < length {
            return Event::NeedMore;
        }
        let raw = self.buffer[..length].to_vec();
        let rest = self.buffer[length..].to_vec();
        self.finish(parse(raw, minor, rest))
    }
    fn finish(&mut self, event: Event) -> Event {
        self.finished = true;
        self.buffer.clear();
        event
    }
}
fn parse(raw: Vec<u8>, minor: u16, rest: Vec<u8>) -> Event {
    let mut params = Vec::new();
    let mut seen = HashSet::new();
    let mut offset = 8;
    loop {
        if offset >= raw.len() {
            return error("invalid startup packet layout: missing terminator");
        }
        if raw[offset] == 0 {
            offset += 1;
            break;
        }
        let Some(key_end) = raw[offset..]
            .iter()
            .position(|v| *v == 0)
            .map(|v| v + offset)
        else {
            return error("invalid startup packet layout: unterminated field");
        };
        let Some(value_end) = raw[key_end + 1..]
            .iter()
            .position(|v| *v == 0)
            .map(|v| v + key_end + 1)
        else {
            return error("invalid startup packet layout: unterminated field");
        };
        let (Ok(key), Ok(value)) = (
            std::str::from_utf8(&raw[offset..key_end]),
            std::str::from_utf8(&raw[key_end + 1..value_end]),
        ) else {
            return error("invalid UTF-8 in startup packet");
        };
        if !seen.insert(key.to_string()) {
            return error("duplicate startup parameter");
        }
        params.push((key.to_string(), value.to_string()));
        offset = value_end + 1;
    }
    if offset != raw.len() {
        return error("invalid startup packet layout: expected terminator as last byte");
    }
    if seen.contains("replication") {
        return Event::Error {
            sqlstate: "0A000".into(),
            message: "replication connections are not supported".into(),
        };
    }
    let Some(user) = params
        .iter()
        .find(|v| v.0 == "user")
        .map(|v| v.1.clone())
        .filter(|v| !v.is_empty())
    else {
        return Event::Error {
            sqlstate: "28000".into(),
            message: "no PostgreSQL user name specified in startup packet".into(),
        };
    };
    let database = params
        .iter()
        .find(|v| v.0 == "database")
        .map(|v| v.1.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| user.clone());
    Event::Startup {
        protocol: Protocol { major: 3, minor },
        params,
        user,
        database,
        raw,
        rest,
    }
}
pub fn error_response(sqlstate: &str, message: &str) -> Vec<u8> {
    let body = format!("SFATAL\0VFATAL\0C{sqlstate}\0M{message}\0\0").into_bytes();
    let mut result = vec![b'E'];
    result.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    result.extend(body);
    result
}
