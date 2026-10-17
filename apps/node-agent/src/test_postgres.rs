// SPDX-License-Identifier: Apache-2.0
//! In-process TLS PostgreSQL wire double for agent tests. It completes startup without a
//! password and answers extended-protocol queries with canned rows, so the agent's real SQL
//! runs against a socket.
//!
//! Its cells carry PostgreSQL's own types and wire forms, not the nearest Rust value: a handler
//! that returns `Text` where PostgreSQL returns `inet` hides the decode the agent really
//! performs. The forms below were read from PostgreSQL 18.6 of the product image (`\gdesc` and
//! the text output of every statement the agent issues): `current_database()` is `name`,
//! `inet_server_addr()` is `inet` whose cast to `text` keeps the netmask (`10.0.0.7/32`) while
//! `host()` drops it, `EXTRACT(EPOCH ...)::text` is a numeric with six decimals, an LSN and a WAL
//! file name use upper-case hexadecimal, and `pg_stat_clear_snapshot()` is `void`.
//!
//! The role statements of the role lifecycle read the catalogs of PostgreSQL 18: `pg_roles.rolname`
//! is `name`, `rolcanlogin` and `rolbypassrls` are `bool`, `rolconnlimit` is `int4` (`-1` is no
//! limit) and `rolvaliduntil` is `timestamptz`, which is NULL for no expiry and may be `infinity`;
//! its binary form is an `int8` of microseconds since 2000-01-01 UTC, `infinity` is `i64::MAX`,
//! and its text form is `2030-01-02 03:04:05+00` in a UTC session. `pg_auth_members` joined to
//! `pg_roles` yields one `name` per granted role, `pg_shdepend.refobjid` is `oid` and only its
//! `count(*)` (`int8`) leaves the server, and `pg_terminate_backend()` is `bool`. A NULL is a
//! length of -1 with its column's type, never a text. PostgreSQL refuses a login with a FATAL
//! ErrorResponse at startup: `28P01` for a failed or expired credential, before authentication
//! succeeds, and `53300` for a role at its connection limit, after `AuthenticationOk`.
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

/// A `timestamptz` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instant {
    /// Seconds since the Unix epoch and the microseconds within the second.
    At(i64, u32),
    Infinity,
    NegativeInfinity,
}
impl Instant {
    /// Seconds from 1970-01-01 to 2000-01-01, the epoch of PostgreSQL's timestamps.
    const POSTGRES_EPOCH_SECONDS: i64 = 946_684_800;
    fn binary(self) -> i64 {
        match self {
            Self::At(seconds, micros) => {
                (seconds - Self::POSTGRES_EPOCH_SECONDS) * 1_000_000 + i64::from(micros)
            }
            Self::Infinity => i64::MAX,
            Self::NegativeInfinity => i64::MIN,
        }
    }
    fn text(self) -> String {
        match self {
            Self::Infinity => "infinity".into(),
            Self::NegativeInfinity => "-infinity".into(),
            Self::At(seconds, micros) => {
                let at = time::OffsetDateTime::from_unix_timestamp(seconds).unwrap();
                let fraction = if micros == 0 {
                    String::new()
                } else {
                    format!(".{micros:06}").trim_end_matches('0').to_string()
                };
                format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}{fraction}+00",
                    at.year(),
                    u8::from(at.month()),
                    at.day(),
                    at.hour(),
                    at.minute(),
                    at.second()
                )
            }
        }
    }
}

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
    /// A `timestamptz` (`pg_roles.rolvaliduntil`); NULL is `Null` of its type.
    Timestamptz(Instant),
    /// A NULL of the type with this OID: a length of -1 in both formats.
    Null(i32),
}
impl Cell {
    /// The OID of `timestamptz`, for a `Null` of it.
    pub const TIMESTAMPTZ: i32 = 1184;
    fn oid(&self) -> i32 {
        match self {
            Self::Text(_) => 25,
            Self::Name(_) => 19,
            Self::Bool(_) => 16,
            Self::Int4(_) => 23,
            Self::Int8(_) => 20,
            Self::Inet(_) => 869,
            Self::Void => 2278,
            Self::Timestamptz(_) => Self::TIMESTAMPTZ,
            Self::Null(oid) => *oid,
        }
    }
    /// The bytes of the cell, or `None` for the NULL that is sent as a length of -1.
    fn encode(&self, binary: bool) -> Option<Vec<u8>> {
        Some(match (self, binary) {
            (Self::Null(_), _) => return None,
            (Self::Text(v) | Self::Name(v), _) => v.as_bytes().to_vec(),
            (Self::Bool(v), true) => vec![u8::from(*v)],
            (Self::Bool(v), false) => vec![if *v { b't' } else { b'f' }],
            (Self::Int4(v), true) => v.to_be_bytes().to_vec(),
            (Self::Int4(v), false) => v.to_string().into_bytes(),
            (Self::Int8(v), true) => v.to_be_bytes().to_vec(),
            (Self::Int8(v), false) => v.to_string().into_bytes(),
            (Self::Void, _) => Vec::new(),
            (Self::Timestamptz(at), true) => at.binary().to_be_bytes().to_vec(),
            (Self::Timestamptz(at), false) => at.text().into_bytes(),
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
        })
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
/// Whether the server lets a startup of this user in: `None` accepts it; `Some((SQLSTATE,
/// message))` refuses it with a FATAL ErrorResponse and closes, as PostgreSQL does.
pub type Login = Arc<dyn Fn(&str) -> Option<(&'static str, &'static str)> + Send + Sync>;

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
    /// Listens on `address` (a random loopback port when `None`) with a certificate for `name`;
    /// every login is accepted.
    pub async fn start(
        authority: &Authority,
        name: &str,
        address: Option<SocketAddr>,
        handler: Handler,
    ) -> Self {
        Self::start_with(authority, name, address, handler, Arc::new(|_| None)).await
    }
    /// Like `start`, with the logins `login` refuses.
    pub async fn start_with(
        authority: &Authority,
        name: &str,
        address: Option<SocketAddr>,
        handler: Handler,
        login: Login,
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
                let (acceptor, handler, login) = (acceptor.clone(), handler.clone(), login.clone());
                tokio::spawn(async move {
                    let _ = session(acceptor, tcp, handler, login).await;
                });
            }
        });
        Self { address, task }
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
/// An ErrorResponse of the severity, SQLSTATE and message; FATAL ends the session.
fn error_response(severity: &str, code: &str, text: &str) -> Vec<u8> {
    let mut fields = Vec::new();
    for (tag, value) in [
        (b'S', severity),
        (b'V', severity),
        (b'C', code),
        (b'M', text),
    ] {
        fields.push(tag);
        fields.extend_from_slice(value.as_bytes());
        fields.push(0);
    }
    fields.push(0);
    message(b'E', &fields)
}
async fn session(
    acceptor: TlsAcceptor,
    mut tcp: tokio::net::TcpStream,
    handler: Handler,
    login: Login,
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
    if let Some((code, text)) = login(&user) {
        // A failed credential (class 28) is refused before authentication succeeds; any other
        // refusal, such as a role at its connection limit, follows AuthenticationOk.
        if !code.starts_with("28") {
            tls.write_all(&message(b'R', &0_i32.to_be_bytes())).await?;
        }
        tls.write_all(&error_response("FATAL", code, text)).await?;
        return Ok(());
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
                                match cell.encode(binary) {
                                    Some(bytes) => {
                                        data.extend_from_slice(&(bytes.len() as i32).to_be_bytes());
                                        data.extend(bytes);
                                    }
                                    // A NULL is a length of -1 and no bytes.
                                    None => data.extend_from_slice(&(-1_i32).to_be_bytes()),
                                }
                            }
                            out.extend(message(b'D', &data));
                        }
                        out.extend(message(b'C', format!("SELECT {}\0", rows.len()).as_bytes()));
                    }
                    Answer::Error(code, text) => out.extend(error_response("ERROR", code, text)),
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
