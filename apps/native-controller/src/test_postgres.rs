// SPDX-License-Identifier: Apache-2.0
//! In-process TLS PostgreSQL wire double for controller tests. It completes startup without a
//! password and answers extended-protocol queries with canned rows, so the controller's real SQL
//! runs against a socket. Stopping it closes the listener, which then refuses connections like a
//! Pod whose postmaster is gone.
//!
//! Its cells carry PostgreSQL's own types and wire forms, not the nearest Rust value: a handler
//! that returns `Text` where PostgreSQL returns `inet` hides the decode the controller really
//! performs. The forms below were read from PostgreSQL 18.6 of the product image (`\gdesc` and
//! the text output of every statement the controller issues): `current_database()` is `name`,
//! `inet_server_addr()` is `inet` whose cast to `text` keeps the netmask (`10.0.0.7/32`) while
//! `host()` drops it, `EXTRACT(EPOCH ...)::text` is a numeric with six decimals, an LSN and a WAL
//! file name use upper-case hexadecimal, and `pg_stat_clear_snapshot()` is `void`.
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

/// One cell of a canned result row.
#[derive(Clone, Debug)]
pub enum Cell {
    Text(String),
    /// The `name` type (`current_database()`, `datname`, `pg_get_userbyid()`); text on the wire.
    Name(String),
    Bool(bool),
    Int4(i32),
    Int8(i64),
    /// An `inet` value in PostgreSQL's binary form. Only a cast to `text` or `host()` makes it
    /// text; read as a string it is a `WrongType` error, as with the real server.
    Inet(String),
    /// The `void` of `pg_stat_clear_snapshot()`: no bytes.
    Void,
}
impl Cell {
    fn oid(&self) -> i32 {
        match self {
            Self::Text(_) => 25,
            Self::Name(_) => 19,
            Self::Bool(_) => 16,
            Self::Int4(_) => 23,
            Self::Int8(_) => 20,
            Self::Inet(_) => 869,
            Self::Void => 2278,
        }
    }
    fn encode(&self, binary: bool) -> Vec<u8> {
        match (self, binary) {
            (Self::Text(v) | Self::Name(v), _) => v.as_bytes().to_vec(),
            (Self::Bool(v), true) => vec![u8::from(*v)],
            (Self::Bool(v), false) => vec![if *v { b't' } else { b'f' }],
            (Self::Int4(v), true) => v.to_be_bytes().to_vec(),
            (Self::Int4(v), false) => v.to_string().into_bytes(),
            (Self::Int8(v), true) => v.to_be_bytes().to_vec(),
            (Self::Int8(v), false) => v.to_string().into_bytes(),
            (Self::Void, _) => Vec::new(),
            (Self::Inet(v), binary) => {
                let address: std::net::IpAddr = v.parse().expect("an inet cell holds an address");
                let (family, bits, octets) = match address {
                    std::net::IpAddr::V4(a) => (2_u8, 32_u8, a.octets().to_vec()),
                    std::net::IpAddr::V6(a) => (3_u8, 128_u8, a.octets().to_vec()),
                };
                if binary {
                    // `inet_send`: family, bits, is_cidr, address length, address.
                    let mut out = vec![family, bits, 0, octets.len() as u8];
                    out.extend(octets);
                    out
                } else {
                    // `inet_out` omits the netmask of a host address.
                    v.clone().into_bytes()
                }
            }
        }
    }
}
pub type Row = Vec<(&'static str, Cell)>;
pub enum Answer {
    Rows(Vec<Row>),
    /// An ErrorResponse with this SQLSTATE and message.
    Error(&'static str, &'static str),
}
/// Maps (statement text, bound text parameters, session user) to an answer. It is also called
/// without parameters to describe a statement, so it must not depend on them for the layout.
pub type Handler = Arc<dyn Fn(&str, &[String], &str) -> Answer + Send + Sync>;

/// A throwaway certificate authority whose leaf certificates PostgreSQL doubles present.
pub struct Authority {
    pub pem: String,
    issuer: rcgen::CertifiedIssuer<'static, rcgen::KeyPair>,
}
impl Authority {
    pub fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let issuer =
            rcgen::CertifiedIssuer::self_signed(params, rcgen::KeyPair::generate().unwrap())
                .unwrap();
        Self {
            pem: issuer.pem(),
            issuer,
        }
    }
}

pub struct Postgres {
    pub address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Postgres {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Postgres {
    /// Listens on `address` (a random loopback port when `None`) with a certificate for `name`.
    pub async fn start(
        authority: &Authority,
        name: &str,
        address: Option<SocketAddr>,
        handler: Handler,
    ) -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec![name.into()])
            .unwrap()
            .signed_by(&key, &authority.issuer)
            .unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind(address.unwrap_or_else(|| "127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let (acceptor, handler) = (acceptor.clone(), handler.clone());
                tokio::spawn(async move {
                    let _ = session(acceptor, tcp, handler).await;
                });
            }
        });
        Self { address, task }
    }
    /// Closes the listener: later connections are refused. Sessions already open end with it.
    pub fn stop(&self) {
        self.task.abort();
    }
}
fn cstring(bytes: &[u8], at: &mut usize) -> String {
    let end = bytes[*at..].iter().position(|b| *b == 0).unwrap() + *at;
    let value = String::from_utf8_lossy(&bytes[*at..end]).into_owned();
    *at = end + 1;
    value
}
fn i16_at(bytes: &[u8], at: &mut usize) -> i16 {
    let value = i16::from_be_bytes([bytes[*at], bytes[*at + 1]]);
    *at += 2;
    value
}
fn i32_at(bytes: &[u8], at: &mut usize) -> i32 {
    let value = i32::from_be_bytes(bytes[*at..*at + 4].try_into().unwrap());
    *at += 4;
    value
}
fn message(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
    out.extend_from_slice(body);
    out
}
fn parameter_count(sql: &str) -> i16 {
    let mut most = 0;
    let bytes = sql.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'$' {
            let digits: String = sql[at + 1..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(n) = digits.parse::<i16>() {
                most = most.max(n);
            }
        }
        at += 1;
    }
    most
}
async fn session(
    acceptor: TlsAcceptor,
    mut tcp: tokio::net::TcpStream,
    handler: Handler,
) -> std::io::Result<()> {
    let mut request = [0; 8];
    tcp.read_exact(&mut request).await?;
    tcp.write_all(b"S").await?;
    let mut tls = acceptor.accept(tcp).await?;
    let length = tls.read_u32().await? as usize;
    let mut startup = vec![0; length - 4];
    tls.read_exact(&mut startup).await?;
    // Protocol version, then NUL-terminated name/value pairs.
    let mut user = String::new();
    let mut at = 4;
    while at < startup.len() && startup[at] != 0 {
        let name = cstring(&startup, &mut at);
        let value = cstring(&startup, &mut at);
        if name == "user" {
            user = value;
        }
    }
    // AuthenticationOk and ReadyForQuery.
    tls.write_all(&message(b'R', &0_i32.to_be_bytes())).await?;
    tls.write_all(&message(b'Z', b"I")).await?;
    let mut statements: HashMap<String, String> = HashMap::new();
    // portal -> (statement text, text parameters, result format codes)
    let mut portals: HashMap<String, (String, Vec<String>, Vec<i16>)> = HashMap::new();
    loop {
        let kind = tls.read_u8().await?;
        let length = tls.read_u32().await? as usize;
        let mut body = vec![0; length - 4];
        tls.read_exact(&mut body).await?;
        let mut at = 0;
        let mut out = Vec::new();
        match kind {
            b'P' => {
                let name = cstring(&body, &mut at);
                let sql = cstring(&body, &mut at);
                statements.insert(name, sql);
                out.extend(message(b'1', &[]));
            }
            b'D' => {
                let target = body[0];
                at = 1;
                let name = cstring(&body, &mut at);
                let sql = if target == b'S' {
                    statements.get(&name).cloned().unwrap_or_default()
                } else {
                    portals.get(&name).map(|p| p.0.clone()).unwrap_or_default()
                };
                let mut parameters = Vec::new();
                parameters.extend_from_slice(&parameter_count(&sql).to_be_bytes());
                for _ in 0..parameter_count(&sql) {
                    parameters.extend_from_slice(&25_i32.to_be_bytes());
                }
                if target == b'S' {
                    out.extend(message(b't', &parameters));
                }
                match handler(&sql, &[], &user) {
                    Answer::Rows(rows) if !rows.is_empty() => {
                        let mut fields = Vec::new();
                        fields.extend_from_slice(&(rows[0].len() as i16).to_be_bytes());
                        for (name, cell) in &rows[0] {
                            fields.extend_from_slice(name.as_bytes());
                            fields.push(0);
                            fields.extend_from_slice(&0_i32.to_be_bytes());
                            fields.extend_from_slice(&0_i16.to_be_bytes());
                            fields.extend_from_slice(&cell.oid().to_be_bytes());
                            fields.extend_from_slice(&(-1_i16).to_be_bytes());
                            fields.extend_from_slice(&(-1_i32).to_be_bytes());
                            fields.extend_from_slice(&0_i16.to_be_bytes());
                        }
                        out.extend(message(b'T', &fields));
                    }
                    _ => out.extend(message(b'n', &[])),
                }
            }
            b'B' => {
                let portal = cstring(&body, &mut at);
                let statement = cstring(&body, &mut at);
                let formats = i16_at(&body, &mut at);
                for _ in 0..formats {
                    i16_at(&body, &mut at);
                }
                let count = i16_at(&body, &mut at);
                let mut parameters = Vec::new();
                for _ in 0..count {
                    let size = i32_at(&body, &mut at);
                    if size < 0 {
                        parameters.push(String::new());
                    } else {
                        let end = at + size as usize;
                        parameters.push(String::from_utf8_lossy(&body[at..end]).into_owned());
                        at = end;
                    }
                }
                let results = i16_at(&body, &mut at);
                let mut result_formats = Vec::new();
                for _ in 0..results {
                    result_formats.push(i16_at(&body, &mut at));
                }
                let sql = statements.get(&statement).cloned().unwrap_or_default();
                portals.insert(portal, (sql, parameters, result_formats));
                out.extend(message(b'2', &[]));
            }
            b'E' => {
                let portal = cstring(&body, &mut at);
                let (sql, parameters, formats) = portals.get(&portal).cloned().unwrap_or_default();
                match handler(&sql, &parameters, &user) {
                    Answer::Rows(rows) => {
                        for row in &rows {
                            let mut data = Vec::new();
                            data.extend_from_slice(&(row.len() as i16).to_be_bytes());
                            for (index, (_, cell)) in row.iter().enumerate() {
                                let binary = match formats.as_slice() {
                                    [] => false,
                                    [one] => *one == 1,
                                    many => many.get(index).is_some_and(|f| *f == 1),
                                };
                                let bytes = cell.encode(binary);
                                data.extend_from_slice(&(bytes.len() as i32).to_be_bytes());
                                data.extend(bytes);
                            }
                            out.extend(message(b'D', &data));
                        }
                        out.extend(message(b'C', format!("SELECT {}\0", rows.len()).as_bytes()));
                    }
                    Answer::Error(code, text) => {
                        let mut fields = Vec::new();
                        for (tag, value) in [(b'S', "ERROR"), (b'C', code), (b'M', text)] {
                            fields.push(tag);
                            fields.extend_from_slice(value.as_bytes());
                            fields.push(0);
                        }
                        fields.push(0);
                        out.extend(message(b'E', &fields));
                    }
                }
            }
            b'S' => {
                out.extend(message(b'Z', b"I"));
            }
            b'C' => out.extend(message(b'3', &[])),
            b'H' => {}
            b'X' => return Ok(()),
            _ => return Ok(()),
        }
        if !out.is_empty() {
            tls.write_all(&out).await?;
        }
    }
}
