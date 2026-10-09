// SPDX-License-Identifier: Apache-2.0
//! The unknown-route PostgreSQL exchange. It cannot authenticate or forward bytes.
use crate::policy::Hints;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_protocol::{
    constant,
    route::Keyring,
    startup::{Event, StartupReader, error_response},
    wire,
};
use sha2::Sha256;

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Output {
    pub frames: Vec<Vec<u8>>,
    pub close: bool,
}
#[derive(PartialEq, Eq)]
enum Phase {
    Startup,
    First,
    Final,
}
pub fn derive_salt(keys: &Keyring, hints: &Hints) -> Result<String, &'static str> {
    let key = keys.keys.get(&keys.active).ok_or("active key missing")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "invalid key")?;
    mac.update(wire("decoySaltDomain").as_bytes());
    mac.update(
        serde_json::to_string(&[&hints.database, &hints.user])
            .map_err(|_| "invalid hints")?
            .as_bytes(),
    );
    Ok(STANDARD.encode(&mac.finalize().into_bytes()[..16]))
}
fn authentication(code: u32, text: &str) -> Vec<u8> {
    let mut out = vec![b'R'];
    out.extend_from_slice(&(8u32 + text.len() as u32).to_be_bytes());
    out.extend_from_slice(&code.to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    out
}
pub struct Decoy {
    hints: Hints,
    reader: Option<StartupReader>,
    buffer: Vec<u8>,
    phase: Phase,
    nonce: String,
    binding: String,
    salt: Option<String>,
    server_random: [u8; 18],
    closed: bool,
    bytes: usize,
    frames: usize,
}
impl Decoy {
    pub fn new(hints: Hints, salt: Option<String>, server_random: [u8; 18]) -> Self {
        Self {
            hints,
            reader: Some(StartupReader::new(constant("STARTUP_MAX_LENGTH") as usize)),
            buffer: Vec::new(),
            phase: Phase::Startup,
            nonce: String::new(),
            binding: String::new(),
            salt,
            server_random,
            closed: false,
            bytes: 0,
            frames: 0,
        }
    }
    pub fn closed(&self) -> bool {
        self.closed
    }
    pub fn retained_bytes(&self) -> usize {
        self.buffer.len()
            + self
                .reader
                .as_ref()
                .map(StartupReader::buffered_bytes)
                .unwrap_or(0)
    }
    fn finish(&mut self, out: &mut Output, sqlstate: Option<&str>) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(code) = sqlstate {
            out.frames.push(error_response(
                code,
                if code == "28P01" {
                    "password authentication failed"
                } else {
                    "connection rejected"
                },
            ));
        }
        self.reader = None;
        self.buffer = Vec::new();
        self.nonce.clear();
        self.binding.clear();
        out.close = true;
    }
    pub fn abort(&mut self) -> Output {
        let mut out = Output::default();
        self.finish(&mut out, None);
        out
    }
    pub fn deadline(&mut self) -> Output {
        let mut out = Output::default();
        self.finish(&mut out, Some("28P01"));
        out
    }
    pub fn invalid_frame(&mut self) -> Output {
        self.deadline()
    }
    /// Host adapter checks byte length before copying a frame out of JavaScript.
    pub fn accepts_frame_length(&self, length: usize) -> bool {
        let retained = if self.phase == Phase::Startup {
            (constant("STARTUP_MAX_LENGTH") as usize).saturating_sub(
                self.reader
                    .as_ref()
                    .map(StartupReader::buffered_bytes)
                    .unwrap_or(0),
            )
        } else {
            constant("DECOY_AUTH_MAX_BYTES") as usize + 1
        };
        !self.closed
            && self.frames < constant("DECOY_MAX_FRAMES") as usize
            && length <= (constant("DECOY_MAX_BYTES") as usize).saturating_sub(self.bytes)
            && length <= retained.saturating_sub(self.buffer.len())
    }
    pub fn push(&mut self, chunk: &[u8]) -> Output {
        let mut out = Output::default();
        if self.closed {
            return out;
        }
        if !self.accepts_frame_length(chunk.len()) {
            self.finish(&mut out, Some("28P01"));
            return out;
        }
        self.frames += 1;
        self.bytes += chunk.len();
        self.buffer.extend_from_slice(chunk);
        while !self.closed {
            if self.phase == Phase::Startup {
                let input = std::mem::take(&mut self.buffer);
                let event = self.reader.as_mut().unwrap().push(&input);
                match event {
                    Event::NeedMore => break,
                    Event::Ssl | Event::Gss => {
                        out.frames.push(vec![b'N']);
                        continue;
                    }
                    Event::Cancel => {
                        self.finish(&mut out, None);
                        break;
                    }
                    Event::Error { sqlstate, .. } => {
                        self.finish(&mut out, Some(&sqlstate));
                        break;
                    }
                    Event::Startup {
                        database,
                        user,
                        rest,
                        ..
                    } => {
                        if database != self.hints.database || user != self.hints.user {
                            self.finish(&mut out, Some("28000"));
                            break;
                        }
                        self.reader = None;
                        self.buffer = rest;
                        self.phase = Phase::First;
                        if self.buffer.len() > constant("DECOY_AUTH_MAX_BYTES") as usize + 1 {
                            self.finish(&mut out, Some("28P01"));
                            break;
                        }
                        out.frames
                            .push(authentication(10, "SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0"));
                    }
                }
            }
            if self.buffer.len() < 5 {
                break;
            }
            let length = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;
            if self.buffer[0] != b'p'
                || length < 4
                || length > constant("DECOY_AUTH_MAX_BYTES") as usize
            {
                self.finish(&mut out, Some("28P01"));
                break;
            }
            if self.buffer.len() < length + 1 {
                break;
            }
            let body = self.buffer[5..length + 1].to_vec();
            self.buffer.drain(..length + 1);
            if self.phase == Phase::First {
                let Some(end) = body.iter().position(|v| *v == 0) else {
                    self.finish(&mut out, Some("28P01"));
                    break;
                };
                if &body[..end] != b"SCRAM-SHA-256" || body.len() < end + 5 {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                let declared = i32::from_be_bytes(body[end + 1..end + 5].try_into().unwrap());
                if declared < 0 || declared as usize != body.len() - end - 5 {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                let Ok(first) = std::str::from_utf8(&body[end + 5..]) else {
                    self.finish(&mut out, Some("28P01"));
                    break;
                };
                if !first.starts_with("n,,") && !first.starts_with("y,,") {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                let parts: Vec<_> = first[3..].split(',').collect();
                if parts.len() != 2 || !parts[0].starts_with("n=") || !parts[1].starts_with("r=") {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                let user = &parts[0][2..];
                let unescaped = user.replace("=2C", "").replace("=3D", "");
                let client_nonce = &parts[1][2..];
                if unescaped.contains(['=', ','])
                    || user.chars().any(|v| v <= '\u{20}' || v == '\u{7f}')
                    || client_nonce.is_empty()
                    || client_nonce.len() > 1024
                    || !client_nonce
                        .bytes()
                        .all(|v| (33..=126).contains(&v) && v != b',')
                {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                self.binding = STANDARD.encode(&first.as_bytes()[..3]);
                self.nonce = format!("{client_nonce}{}", STANDARD.encode(self.server_random));
                let Some(salt) = &self.salt else {
                    self.finish(&mut out, Some("28P01"));
                    break;
                };
                self.phase = Phase::Final;
                out.frames.push(authentication(
                    11,
                    &format!(
                        "r={},s={salt},i={}",
                        self.nonce,
                        constant("DECOY_SCRAM_ITERATIONS")
                    ),
                ));
            } else {
                let Ok(final_message) = std::str::from_utf8(&body) else {
                    self.finish(&mut out, Some("28P01"));
                    break;
                };
                let parts: Vec<_> = final_message.split(',').collect();
                let valid = parts.len() == 3
                    && parts[0] == format!("c={}", self.binding)
                    && parts[1] == format!("r={}", self.nonce)
                    && parts[2].starts_with("p=");
                if !valid {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                let proof = &parts[2][2..];
                let proof_valid = proof.len() == 44
                    && proof.ends_with('=')
                    && proof[..43]
                        .bytes()
                        .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'+' | b'/'))
                    && STANDARD
                        .decode(proof)
                        .is_ok_and(|decoded| STANDARD.encode(decoded) == proof);
                // A validly structured proof always fails. There is no verifier or AuthenticationOk.
                if !proof_valid {
                    self.finish(&mut out, Some("28P01"));
                    break;
                }
                self.finish(&mut out, Some("28P01"));
            }
        }
        out
    }
}
